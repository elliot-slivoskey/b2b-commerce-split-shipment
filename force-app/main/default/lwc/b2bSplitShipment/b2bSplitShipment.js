import { LightningElement, api, track, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { publish, MessageContext } from 'lightning/messageService';
import SPLIT_SHIPMENT_SYNC from '@salesforce/messageChannel/SplitShipmentSync__c';
import COMMUNITYID from '@salesforce/community/Id';
import resolveCartId from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.resolveCartId';
import getState from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.getState';
import createDeliveryGroup from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.createDeliveryGroup';
import arrangeItems from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.arrangeItems';
import updateDeliveryGroup from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.updateDeliveryGroup';
import updateItemQuantity from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.updateItemQuantity';
import deleteDeliveryGroup from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.deleteDeliveryGroup';
import deleteCartItem from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.deleteCartItem';
import splitCartItem from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.splitCartItem';
import addItemToGroup from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.addItemToGroup';
import clearDesiredDate from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.clearDesiredDate';
import moveItemMerge from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.moveItemMerge';
// Managed-storefront cart data store. Our cart writes go out-of-band through the Apex/Connect REST
// callout, which never invalidates this client-side store — so the managed "Cart Summary" totals
// panel (backed by its CartSummaryAdapter wire) stays stale until a reload. refreshCartSummary()
// is the supported hook to make it re-read. See refreshManagedCartSummary() for the important
// caveat about WHEN to call it.
import { refreshCartSummary } from 'commerce/cartApi';

const CONFLICT = /\(409\)|CONFLICT|Version Mismatch/i;
const NEW_ADDRESS = '__new__';

export default class B2bSplitShipment extends NavigationMixin(LightningElement) {
    @api cartId;
    @api headerTitle = 'Plan your shipments';
    @api headerDescription =
        'Group your items into shipments. Each shipment can have its own address, delivery method, and requested delivery date.';
    // URL of the checkout page to return to; overridable in the builder.
    @api checkoutUrl = 'https://YOUR_MYDOMAIN.my.site.com/YOUR_STORE_PATH/checkout';

    @track shipments = [];
    @track addressBook = [];
    @track pendingIds = [];
    splitShipmentEnabled = false;
    multiMode = true; // buyer already chose to split; launch straight in
    loading = true;
    busy = false;
    creating = false;
    error;
    info;

    // Address form state
    showAddressForm = false;
    addressFormMode = 'new'; // 'new' (add shipment) | 'change' (existing shipment, new address)
    entryMode = 'book'; // 'book' (pick saved) | 'manual' (type new)
    changingShipmentId;
    selectedBookId;
    editingAddressShipmentId; // shipment whose address row shows the inline dropdown
    @track form = this.blankForm();

    // Quantity-split state
    splittingItemId;
    splitQty = null;
    splitTargetId;
    splitError;

    // Single-level undo for a removed line (remembers only the last delete — cheap).
    @track undoItem;

    @wire(MessageContext) messageContext;

    connectedCallback() {
        this.refresh();
    }

    // ---------- data ----------

    async refresh() {
        this.loading = true;
        try {
            await this.loadState();
            this.error = undefined;
        } catch (e) {
            this.error = this.msg(e);
        }
        this.loading = false;
    }

    // Reloads shipment data without the full-screen spinner (used after mutations).
    async silentRefresh() {
        await this.loadState();
    }

    // Many cart writes are processed asynchronously (HTTP 202) and some server-side reflows
    // (notably a deleted group's items returning to the default group) can take several seconds.
    // A single refetch returns stale data; worse, if we simply stop polling, a change that lands
    // AFTER the budget never reaches the UI until the buyer's next action. So: poll until the
    // expected result appears, and if the budget runs out, do one final GRACE reconcile after a
    // longer pause so a late-completing change still redraws instead of leaving a stale UI.
    async loadStateUntil(check, attempts = 8, delay = 700) {
        for (let i = 0; i < attempts; i++) {
            await this.loadState();
            if (check()) {
                return true;
            }
            if (i < attempts - 1) {
                await this.sleep(delay);
            }
        }
        // Grace reconcile: absorb reflows that outlast the polling budget.
        await this.sleep(1500);
        await this.loadState();
        return check();
    }

    async loadState() {
        if (!this.cartId) {
            this.cartId = await resolveCartId({ communityId: COMMUNITYID, cartId: this.cartId });
        }
        const s = JSON.parse(await getState({ cartId: this.cartId }));
        this.splitShipmentEnabled = s.splitShipmentEnabled;
        this.addressBook = (s.addressBook || []).map((a) => ({
            ...a,
            label: this.addrLabel(a),
            value: a.id
        }));
        const items = (s.deliveryGroups && s.deliveryGroups.items) || [];
        this.shipments = this.numberShipments(this.sortShipments(items.map((g) => this.mapGroup(g))));
    }

    // The shipment NUMBER is a display label derived from sorted position (default = 1, then
    // 2..N by id order), NOT the server-stored group name. If we trusted the stored name, the
    // numbers would leave gaps as shipments are deleted: delete "Shipment 2" and the next
    // "Shipment ${count+1}" create collides with the surviving "Shipment 3" — you'd see two
    // "Shipment 3". Numbering by position instead means the list always reads 1..N and #3
    // renumbers to #2 the moment #2 is removed. Purely cosmetic; the stored CartDeliveryGroup
    // name is untouched.
    numberShipments(sorted) {
        sorted.forEach((s, i) => {
            s.name = `Shipment ${i + 1}`;
        });
        return sorted;
    }

    mapGroup(g) {
        const wraps = (g.cartItems && g.cartItems.cartItems) || [];
        const items = wraps.map((w) => {
            const it = w.cartItem || {};
            const qty = Number(it.quantity);
            const extended = Number(it.totalAmount != null ? it.totalAmount : it.totalPrice);
            // Derive the effective unit price from the extended amount so the two
            // always reconcile (list/sales price can differ from the discounted line).
            const unit = !isNaN(extended) && qty > 0 ? extended / qty : NaN;
            return {
                id: it.cartItemId,
                productId: it.productId,
                name: it.name,
                sku: it.productDetails && it.productDetails.sku,
                image: it.productDetails && it.productDetails.thumbnailImage && it.productDetails.thumbnailImage.url,
                quantity: qty,
                unitAmount: this.money(unit),
                amount: this.money(extended)
            };
        });
        // Stable order by cart item id so a quantity change never reorders lines.
        items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const methods = (g.availableDeliveryMethods || []).map((m) => ({
            label: `${m.name} — ${this.money(m.shippingFee)}`,
            value: m.id
        }));
        const dateOnly = g.desiredDeliveryDate ? g.desiredDeliveryDate.substring(0, 10) : null;
        return {
            id: g.id,
            // Overwritten with a positional label in numberShipments(); the stored g.name is
            // only a fallback if numbering is somehow skipped.
            name: g.name,
            isDefault: g.isDefault === true,
            address: g.deliveryAddress || null,
            addressLabel: this.addrLabel(g.deliveryAddress),
            shortAddress: this.shortAddr(g.deliveryAddress),
            dateLabel: dateOnly || 'ASAP',
            desiredDeliveryDate: dateOnly,
            selectedMethodId: g.selectedDeliveryMethod ? g.selectedDeliveryMethod.id : null,
            methodOptions: methods,
            hasMethods: methods.length > 0,
            items: items
        };
    }

    // ---------- background mutation runner (no full redraw; grays affected shipments) ----------

    async mutate(fn, pendingShipmentIds = []) {
        this.error = undefined;
        this.pendingIds = [...this.pendingIds, ...pendingShipmentIds];
        try {
            try {
                await fn();
            } catch (e) {
                if (CONFLICT.test(this.msg(e))) {
                    await this.sleep(1200);
                    await fn();
                } else {
                    throw e;
                }
            }
            await this.silentRefresh();
            publish(this.messageContext, SPLIT_SHIPMENT_SYNC, { source: 'main' });
            await this.refreshManagedCartSummary();
        } catch (e) {
            this.error = this.msg(e);
            // reconcile back to server truth (undo any optimistic change)
            await this.silentRefresh();
        } finally {
            this.pendingIds = this.pendingIds.filter((id) => !pendingShipmentIds.includes(id));
        }
    }

    // Nudges the managed "Cart Summary" totals panel to re-read the cart after one of our
    // out-of-band Connect REST mutations. IMPORTANT ordering: refreshCartSummary() only re-reads
    // the ALREADY-computed totals — it does NOT trigger the server pricing/tax/shipping recalc
    // (that recalc is kicked off by our cart write and runs async). So this must be called only
    // AFTER our settle (loadStateUntil / silentRefresh) has confirmed the server calc landed,
    // otherwise the panel would re-read mid-calculation values. Every caller here already awaits
    // its settle before calling this.
    //   - Defensive: a refresh hiccup must never break the cart mutation that just succeeded, so
    //     errors are swallowed (the totals still reconcile on the buyer's next navigation).
    //   - Timeout-capped: if the store refresh ever hangs it must not keep a shipment grayed, so
    //     we race it against a ceiling and move on.
    async refreshManagedCartSummary() {
        try {
            await Promise.race([refreshCartSummary(), this.sleep(8000)]);
        } catch (e) {
            // non-fatal — leave the mutation's success intact
        }
    }

    // Default shipment first; newly-added shipments fall to the bottom (by id order).
    sortShipments(list) {
        return [...list].sort((a, b) => {
            if (a.isDefault !== b.isDefault) {
                return a.isDefault ? -1 : 1;
            }
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
    }

    // ---------- add / delete shipment ----------

    get targetOptions() {
        return this.shipments.map((s) => ({ label: s.name, value: s.id }));
    }

    handleAddShipment() {
        this.addressFormMode = 'new';
        this.changingShipmentId = undefined;
        this.resetAddressForm();
        this.showAddressForm = true;
    }

    // Removes a shipment — but ONLY an empty one (the trash icon is disabled while it still holds
    // items, and this guard enforces the same rule). This is deliberate. Deleting a shipment that
    // still has items makes the PLATFORM reflow those items back into the default group, and that
    // reflow is asynchronous, slow, AND lands as separate duplicate lines (it never merges them
    // into the default's existing same-product line) — so the result was non-deterministic
    // ("sometimes merges, sometimes not") and left units looking hidden. Requiring the buyer to
    // move everything out first removes that fragile path entirely: an empty group has nothing to
    // reflow, so the delete is instant and reliable.
    async handleDeleteShipment(event) {
        const id = event.currentTarget.dataset.id;
        const ship = this.shipments.find((s) => s.id === id);
        if (ship && ship.items.length > 0) {
            this.error = 'Move or remove all items out of this shipment before deleting it.';
            return;
        }
        this.error = undefined;
        this.pendingIds = [...this.pendingIds, id];
        try {
            await this.deleteGroupResilient(id);
            await this.loadStateUntil(() => !this.shipments.find((s) => s.id === id));
            publish(this.messageContext, SPLIT_SHIPMENT_SYNC, { source: 'main' });
            await this.refreshManagedCartSummary();
        } catch (e) {
            this.error = this.msg(e);
            await this.silentRefresh();
        } finally {
            this.pendingIds = this.pendingIds.filter((x) => x !== id);
        }
    }

    // Deleting a shipment can fire while the platform is still recalculating a change that just
    // completed (e.g. moving the last items out of it), which comes back as a 409 CHECKOUT_CONFLICT
    // ("Checkout calculations are still running. Wait for the calculations to complete."). The
    // server-side call already retries once immediately, but that isn't enough when the calc needs
    // a beat — so retry here with a growing backoff before giving up.
    async deleteGroupResilient(id) {
        const maxAttempts = 4;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                await deleteDeliveryGroup({ cartId: this.cartId, deliveryGroupId: id });
                return;
            } catch (e) {
                const m = this.msg(e);
                const retriable = CONFLICT.test(m) || /calculations are still running/i.test(m);
                if (retriable && attempt < maxAttempts - 1) {
                    await this.sleep(1500 * (attempt + 1));
                    continue;
                }
                throw e;
            }
        }
    }

    // Removes a single line item from the order entirely (distinct from removing a shipment).
    // Remembers just this one line so it can be restored with Undo (re-added to the same group).
    handleDeleteItem(event) {
        const cartItemId = event.currentTarget.dataset.item;
        const groupId = event.currentTarget.dataset.group;
        const item = this.findItem(groupId, cartItemId);
        if (item && item.productId) {
            this.undoItem = {
                productId: item.productId,
                quantity: item.quantity,
                groupId,
                name: item.name
            };
        }
        // optimistic: drop the line locally so it disappears immediately
        this.shipments = this.shipments.map((s) =>
            s.id === groupId ? { ...s, items: s.items.filter((i) => i.id !== cartItemId) } : s
        );
        this.mutate(() => deleteCartItem({ cartId: this.cartId, cartItemId }), [groupId]);
    }

    // Restores the last removed line by re-adding it to the group it came from. The add is
    // async (202), so refresh until the line reappears — otherwise the restored line wouldn't
    // show until some later action forced a redraw.
    async handleUndoDelete() {
        const u = this.undoItem;
        if (!u || this.undoPending) {
            return; // the original delete is still settling — don't stack a re-add on top of it
        }
        this.undoItem = undefined;
        this.error = undefined;
        this.pendingIds = [...this.pendingIds, u.groupId];
        try {
            await addItemToGroup({
                cartId: this.cartId,
                productId: u.productId,
                quantity: u.quantity,
                deliveryGroupId: u.groupId
            });
            await this.loadStateUntil(() => {
                const g = this.shipments.find((s) => s.id === u.groupId);
                return !!(g && g.items.find((i) => i.productId === u.productId));
            });
            publish(this.messageContext, SPLIT_SHIPMENT_SYNC, { source: 'main' });
            await this.refreshManagedCartSummary();
        } catch (e) {
            this.error = this.msg(e);
            await this.silentRefresh();
        } finally {
            this.pendingIds = this.pendingIds.filter((id) => id !== u.groupId);
        }
    }

    handleDismissUndo() {
        this.undoItem = undefined;
    }

    get undoLabel() {
        return this.undoItem ? `Removed ${this.undoItem.name}.` : '';
    }

    // The removal is still recalculating on the server (its group is pending). While it is, the
    // undo box shows an in-progress style and its Undo button is disabled, so the buyer can't
    // re-add before the delete has settled (which would leave a confusing intermediate state).
    get undoPending() {
        return !!this.undoItem && this.pendingIds.includes(this.undoItem.groupId);
    }

    get undoBoxClass() {
        const base = 'slds-box slds-box_x-small slds-m-bottom_small ss-undo';
        return this.undoPending ? `${base} ss-undo-pending` : base;
    }

    // ---------- address form (address-book first; fields only for a new address) ----------

    resetAddressForm() {
        this.entryMode = this.addressBook.length ? 'book' : 'manual';
        this.selectedBookId = undefined;
        this.form = this.blankForm();
    }

    get addressBookOptions() {
        return [...this.addressBook, { label: '＋ Enter a new address', value: NEW_ADDRESS }];
    }

    get showManualFields() {
        return this.entryMode === 'manual';
    }

    // Save button only appears in manual-entry mode, so it gates on the typed street.
    get disableSave() {
        return !this.form.street;
    }

    get addressFormTitle() {
        return this.addressFormMode === 'change'
            ? 'Enter a new address'
            : 'Select shipping address to create shipment';
    }

    get saveButtonLabel() {
        return this.addressFormMode === 'change' ? 'Save address' : 'Add shipment';
    }

    // ----- inline address change on an existing shipment (pencil -> dropdown) -----

    handleEditAddressInline(event) {
        this.editingAddressShipmentId = event.currentTarget.dataset.id;
    }

    handleCancelInlineEdit() {
        this.editingAddressShipmentId = undefined;
    }

    handleInlineAddressPick(event) {
        const id = event.target.dataset.id;
        const value = event.target.value;
        if (!value) {
            return;
        }
        if (value === NEW_ADDRESS) {
            // fall back to the manual form, scoped to this shipment
            this.addressFormMode = 'change';
            this.changingShipmentId = id;
            this.entryMode = 'manual';
            this.form = this.blankForm();
            this.showAddressForm = true;
            this.editingAddressShipmentId = undefined;
            return;
        }
        const a = this.addressBook.find((x) => x.id === value);
        this.editingAddressShipmentId = undefined;
        if (a) {
            const addr = this.bookToAddress(a);
            this.mutate(
                () =>
                    updateDeliveryGroup({
                        cartId: this.cartId,
                        deliveryGroupId: id,
                        patchJson: JSON.stringify({ deliveryAddress: addr })
                    }),
                [id]
            );
        }
    }

    // ----- add-shipment picker -----

    handlePickBookAddress(event) {
        const value = event.target.value;
        if (!value) {
            return;
        }
        if (value === NEW_ADDRESS) {
            this.entryMode = 'manual';
            this.selectedBookId = undefined;
            this.form = this.blankForm();
            return;
        }
        // Picking a saved address confirms the new shipment immediately (no separate Save step).
        const a = this.addressBook.find((x) => x.id === value);
        if (a) {
            this.createShipmentWithAddress(this.bookToAddress(a));
        }
    }

    handleFormChange(event) {
        this.form = { ...this.form, [event.target.name]: event.target.value };
    }

    handleCancelAddress() {
        this.showAddressForm = false;
    }

    // Manual-entry confirm: create a new shipment, or apply a typed address to an existing one.
    handleSaveAddress() {
        const addr = { ...this.form };
        if (!addr.name) {
            addr.name = [addr.city, addr.region].filter(Boolean).join(', ');
        }
        if (this.addressFormMode === 'change' && this.changingShipmentId) {
            const id = this.changingShipmentId;
            this.showAddressForm = false;
            this.mutate(
                () =>
                    updateDeliveryGroup({
                        cartId: this.cartId,
                        deliveryGroupId: id,
                        patchJson: JSON.stringify({ deliveryAddress: addr })
                    }),
                [id]
            );
        } else {
            this.createShipmentWithAddress(addr);
        }
    }

    createShipmentWithAddress(addr) {
        const name = `Shipment ${this.shipments.length + 1}`;
        this.showAddressForm = false;
        this.creating = true; // skeleton placeholder while the shipment is created
        this.mutate(() =>
            createDeliveryGroup({ cartId: this.cartId, name, addressJson: JSON.stringify(addr) })
        ).finally(() => {
            this.creating = false;
        });
    }

    bookToAddress(a) {
        return {
            name: a.name,
            street: a.street,
            city: a.city,
            region: a.region,
            postalCode: a.postalCode,
            country: a.country
        };
    }

    // ---------- move a whole item line (optimistic) ----------

    handleMoveItem(event) {
        const cartItemId = event.target.dataset.item;
        const fromId = event.target.dataset.group;
        const targetId = event.target.value;
        if (!targetId || targetId === fromId) {
            event.target.value = ''; // reset the native select back to the placeholder
            return;
        }
        const item = this.findItem(fromId, cartItemId);
        if (!item) {
            return;
        }
        // Close any open split panel/hint before the line relocates — otherwise it's keyed to the
        // cart-item id and would visually "travel" with the item to the destination shipment.
        this.splittingItemId = undefined;
        this.splitError = undefined;
        const qty = item.quantity; // true quantity — carried so it never resets
        // If the destination already has this product, merge into that line (sum quantities)
        // instead of leaving two separate same-product lines in one shipment.
        const targetShip = this.shipments.find((s) => s.id === targetId);
        const existing = targetShip && targetShip.items.find((i) => i.productId === item.productId);
        if (existing) {
            this.mergeMoveItem(cartItemId, existing.id, fromId, targetId, existing.quantity + qty);
            return;
        }
        // optimistic local move so the change shows instantly
        this.shipments = this.shipments.map((s) => {
            if (s.id === fromId) {
                return { ...s, items: s.items.filter((i) => i.id !== cartItemId) };
            }
            if (s.id === targetId) {
                return { ...s, items: [...s.items, item] };
            }
            return s;
        });
        this.moveItemArrange(cartItemId, fromId, targetId, qty);
    }

    // Relocates a whole line to another group, then waits until the line shows in the target AND
    // (if the target has an address) its delivery methods have finished recalculating. Moving the
    // first item into a freshly-created shipment triggers an async delivery-method recompute; a
    // single refetch reads it back empty, so the method row briefly showed "Available once the
    // address is set" against a shipment that already HAS an address. Waiting for the methods
    // avoids that stale flash. Dedicated (not mutate) so we can extend the settle check.
    async moveItemArrange(cartItemId, fromId, targetId, qty) {
        const args = {
            cartId: this.cartId,
            arrangementsJson: JSON.stringify([{ deliveryGroupId: targetId, cartItemId, quantity: qty }])
        };
        this.error = undefined;
        this.pendingIds = [...this.pendingIds, fromId, targetId];
        try {
            try {
                await arrangeItems(args);
            } catch (e) {
                if (CONFLICT.test(this.msg(e))) {
                    await this.sleep(1200);
                    await arrangeItems(args);
                } else {
                    throw e;
                }
            }
            await this.loadStateUntil(() => {
                const t = this.shipments.find((s) => s.id === targetId);
                return !!(t && t.items.find((i) => i.id === cartItemId)) && this.groupMethodsReady(targetId);
            });
            publish(this.messageContext, SPLIT_SHIPMENT_SYNC, { source: 'main' });
            await this.refreshManagedCartSummary();
        } catch (e) {
            this.error = this.msg(e);
            await this.silentRefresh();
        } finally {
            this.pendingIds = this.pendingIds.filter((id) => id !== fromId && id !== targetId);
        }
    }

    // True once a group's delivery methods are usable: methods present, OR the group has no address
    // yet (in which case methods legitimately can't exist, so there's nothing to wait for).
    groupMethodsReady(groupId) {
        const g = this.shipments.find((s) => s.id === groupId);
        if (!g) {
            return false;
        }
        if (!g.address) {
            return true;
        }
        return !!(g.methodOptions && g.methodOptions.length > 0);
    }

    // Merge-move: bump the destination's existing line to the combined quantity, drop the
    // source line. Dedicated (not mutate) so the blanket 409-retry can't double-apply; refreshes
    // until both the summed quantity shows on the target line and the source line is gone.
    async mergeMoveItem(sourceCartItemId, targetCartItemId, fromId, targetId, newQuantity) {
        this.error = undefined;
        // Optimistic UI: bump the target's existing line to the combined quantity and drop the
        // source line immediately, so the destination reflects the merge without waiting on the
        // async settle. loadState reconciles afterward.
        this.shipments = this.shipments.map((s) => {
            if (s.id === fromId) {
                return { ...s, items: s.items.filter((i) => i.id !== sourceCartItemId) };
            }
            if (s.id === targetId) {
                return {
                    ...s,
                    items: s.items.map((it) =>
                        it.id === targetCartItemId
                            ? { ...it, quantity: newQuantity, amount: this.money(this.unitOf(it) * newQuantity) }
                            : it
                    )
                };
            }
            return s;
        });
        this.pendingIds = [...this.pendingIds, fromId, targetId];
        try {
            await moveItemMerge({
                cartId: this.cartId,
                sourceCartItemId,
                targetCartItemId,
                newQuantity
            });
            await this.loadStateUntil(() => {
                const line = this.findItem(targetId, targetCartItemId);
                const sourceGone = !this.findItem(fromId, sourceCartItemId);
                return !!line && line.quantity >= newQuantity && sourceGone;
            });
            publish(this.messageContext, SPLIT_SHIPMENT_SYNC, { source: 'main' });
            await this.refreshManagedCartSummary();
        } catch (e) {
            this.error = this.msg(e);
            await this.silentRefresh();
        } finally {
            this.pendingIds = this.pendingIds.filter((id) => id !== fromId && id !== targetId);
        }
    }

    // ---------- split a line's quantity across shipments ----------

    handleStartSplit(event) {
        const cartItemId = event.target.dataset.item;
        const fromId = event.target.dataset.group;
        // Toggle: pressing Split again on the same line closes the panel/hint (so the qty-of-1
        // hint dismisses on a second press rather than needing an "OK" confirmation).
        if (this.splittingItemId === cartItemId) {
            this.splittingItemId = undefined;
            this.splitError = undefined;
            return;
        }
        const item = this.findItem(fromId, cartItemId);
        this.splitError = undefined;
        if (!item || item.quantity < 2) {
            this.splitError = 'To ship to multiple addresses, increase the quantity.';
            this.splittingItemId = cartItemId;
            return;
        }
        this.splittingItemId = cartItemId;
        this.splitQty = null; // start empty — the buyer types how many to split off
        this.splitTargetId = undefined;
    }

    handleSplitQtyChange(event) {
        const v = parseInt(event.target.value, 10);
        this.splitQty = isNaN(v) ? null : v;
    }

    handleSplitTargetChange(event) {
        this.splitTargetId = event.detail.value;
    }

    handleCancelSplit() {
        this.splittingItemId = undefined;
        this.splitError = undefined;
    }

    handleApplySplit(event) {
        const cartItemId = this.splittingItemId;
        const fromId = event.target.dataset.group;
        const item = this.findItem(fromId, cartItemId);
        if (!item) {
            return;
        }
        if (!this.splitTargetId) {
            this.splitError = 'Choose a shipment to move the quantity to.';
            return;
        }
        if (!(this.splitQty >= 1 && this.splitQty < item.quantity)) {
            this.splitError = `Enter a quantity between 1 and ${item.quantity - 1}.`;
            return;
        }
        const target = this.splitTargetId;
        const qty = this.splitQty;
        const remaining = item.quantity - qty;
        this.splittingItemId = undefined;
        this.applySplit(cartItemId, item.productId, fromId, target, remaining, qty);
    }

    // Splits a line: adds `qty` of the product as a new line in the target shipment, then
    // reduces the source line to `remaining`. The server-side method orders these so a
    // partial failure leaves extra (recoverable) units rather than losing any. Runs outside
    // mutate() deliberately — its blanket retry would re-add the target line on a conflict,
    // whereas splitCartItem retries only the idempotent reduce internally.
    async applySplit(cartItemId, productId, fromId, target, remaining, qty) {
        if (!productId) {
            this.splitError = 'Could not resolve the product to split.';
            this.splittingItemId = cartItemId;
            return;
        }
        this.error = undefined;
        this.info = undefined;
        // Total we expect on the target for this product once the split settles (existing + moved).
        const targetBefore = this.shipments.find((s) => s.id === target);
        const expectedTarget = this.sumQty(targetBefore, productId) + qty;
        // Optimistic UI: reduce the source line and show the moved units on the target NOW, rather
        // than waiting for the async add to land — otherwise a slow settle looks like the
        // destination never updated. loadState reconciles the temp line to the real one.
        const srcItem = this.findItem(fromId, cartItemId);
        const unit = srcItem ? this.unitOf(srcItem) : 0;
        const tempId = `tmp-${cartItemId}-${Date.now()}`;
        this.shipments = this.shipments.map((s) => {
            if (s.id === fromId) {
                return {
                    ...s,
                    items: s.items.map((it) =>
                        it.id === cartItemId
                            ? { ...it, quantity: remaining, amount: this.money(unit * remaining) }
                            : it
                    )
                };
            }
            if (s.id === target) {
                const existing = s.items.find((i) => i.productId === productId);
                if (existing) {
                    return {
                        ...s,
                        items: s.items.map((it) =>
                            it.id === existing.id
                                ? { ...it, quantity: it.quantity + qty, amount: this.money(this.unitOf(it) * (it.quantity + qty)) }
                                : it
                        )
                    };
                }
                const clone = srcItem
                    ? { ...srcItem, id: tempId, quantity: qty, amount: this.money(unit * qty) }
                    : { id: tempId, productId, name: '', quantity: qty, unitAmount: this.money(unit), amount: this.money(unit * qty) };
                return { ...s, items: [...s.items, clone] };
            }
            return s;
        });
        this.pendingIds = [...this.pendingIds, fromId, target];
        try {
            await splitCartItem({
                cartId: this.cartId,
                sourceCartItemId: cartItemId,
                productId,
                targetGroupId: target,
                moveQty: qty,
                remainingQty: remaining
            });
            // The add into the target is async (202); refresh until the target reflects the
            // expected total (summed across lines, in case it lands as a separate line).
            await this.loadStateUntil(() => {
                const g = this.shipments.find((s) => s.id === target);
                return !!g && this.sumQty(g, productId) >= expectedTarget && this.groupMethodsReady(target);
            });
            publish(this.messageContext, SPLIT_SHIPMENT_SYNC, { source: 'main' });
            await this.refreshManagedCartSummary();
        } catch (e) {
            this.error = `Split failed: ${this.msg(e)}`;
            await this.silentRefresh();
        } finally {
            this.pendingIds = this.pendingIds.filter((id) => id !== fromId && id !== target);
        }
    }

    // ---------- per-line quantity steppers (optimistic) ----------

    handleIncrement(event) {
        this.stepQuantity(event.target.dataset.group, event.target.dataset.item, 1);
    }

    handleDecrement(event) {
        this.stepQuantity(event.target.dataset.group, event.target.dataset.item, -1);
    }

    stepQuantity(groupId, cartItemId, delta) {
        const item = this.findItem(groupId, cartItemId);
        if (item) {
            this.commitQuantity(groupId, cartItemId, item.quantity + delta);
        }
    }

    // Typed quantity entry (the editable box between the steppers).
    handleQtyInput(event) {
        const groupId = event.target.dataset.group;
        const cartItemId = event.target.dataset.item;
        const item = this.findItem(groupId, cartItemId);
        if (!item) {
            return;
        }
        const val = parseInt(event.target.value, 10);
        if (isNaN(val) || val < 1) {
            event.target.value = item.quantity; // reject: snap back to the real value
            return;
        }
        if (val !== item.quantity) {
            this.commitQuantity(groupId, cartItemId, val);
        }
    }

    commitQuantity(groupId, cartItemId, next) {
        const item = this.findItem(groupId, cartItemId);
        if (!item || next < 1 || next === item.quantity) {
            return;
        }
        // If the split panel is open on this line with the "increase the quantity" hint, clear it
        // as soon as there are enough units to split so the stale message doesn't linger.
        if (cartItemId === this.splittingItemId && next >= 2 && this.splitError) {
            this.splitError = undefined;
        }
        // optimistic: update quantity + extended locally
        const unit = this.unitOf(item);
        this.shipments = this.shipments.map((s) => {
            if (s.id !== groupId) {
                return s;
            }
            return {
                ...s,
                items: s.items.map((it) =>
                    it.id === cartItemId
                        ? { ...it, quantity: next, amount: this.money(unit * next) }
                        : it
                )
            };
        });
        this.mutate(() => updateItemQuantity({ cartId: this.cartId, cartItemId, quantity: next }), [groupId]);
    }

    // ---------- per-shipment delivery method + date ----------

    handleMethodChange(event) {
        const id = event.target.dataset.id;
        const methodId = event.target.value; // native <select>
        // Setting a delivery method is async on the server (202) — the immediate refetch
        // returns the OLD method, so we update locally and push the chosen label to the
        // overview optimistically; the next full refresh reconciles it.
        const ship = this.shipments.find((s) => s.id === id);
        const opt = ship && ship.methodOptions.find((m) => m.value === methodId);
        const label = opt ? opt.label : undefined;
        this.shipments = this.shipments.map((s) =>
            s.id === id ? { ...s, selectedMethodId: methodId } : s
        );
        publish(this.messageContext, SPLIT_SHIPMENT_SYNC, {
            source: 'main',
            method: { groupId: id, label }
        });
        this.mutate(
            () =>
                updateDeliveryGroup({
                    cartId: this.cartId,
                    deliveryGroupId: id,
                    patchJson: JSON.stringify({ deliveryMethodId: methodId })
                }),
            [id]
        );
    }

    handleDateChange(event) {
        const id = event.target.dataset.id;
        const val = event.target.value; // yyyy-MM-dd or '' (native <input type="date">)
        if (!val) {
            this.clearDate(id);
            return;
        }
        // A native date input fires `change` on each field, so while the buyer is still typing
        // the year it briefly emits a half-formed date like "0002-01-01" (year 2), which the
        // server rejects (INVALID_CHECKOUT_INPUT). Only commit a complete, plausible date;
        // ignore the intermediate keystrokes so no premature PATCH goes out.
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
        if (!m || parseInt(m[1], 10) < 1000) {
            return;
        }
        this.setDesiredDate(id, val);
    }

    // "ASAP" button: clear the requested date so the platform ships as soon as possible.
    handleClearDate(event) {
        this.clearDate(event.currentTarget.dataset.id);
    }

    setDesiredDate(id, val) {
        const iso = `${val}T00:00:00.000Z`;
        this.mutate(
            () =>
                updateDeliveryGroup({
                    cartId: this.cartId,
                    deliveryGroupId: id,
                    patchJson: JSON.stringify({ desiredDeliveryDate: iso })
                }),
            [id]
        );
    }

    // Connect REST ignores a null date, so clearing goes through a dedicated DML method.
    clearDate(id) {
        this.mutate(() => clearDesiredDate({ deliveryGroupId: id }), [id]);
    }

    // ---------- bulk edit (placeholder) + confirm ----------

    handleBulkEdit() {
        const msg =
            'Bulk edit would let an operator stage many changes across shipments and apply them in ' +
            'one pass, for organizing large, complex orders.\n\n' +
            'Design advice:\n' +
            '• Moving an item onto a shipment that already holds the same product will NOT combine ' +
            'them — a plain add creates a second line, because the platform only merges on add in ' +
            'the default shipment. To sum them you must raise the existing line’s quantity and ' +
            'delete the one you moved; skip that and you get duplicate lines that look like the ' +
            'quantity has vanished.\n' +
            '• There is no split operation. Relocating a line moves its whole quantity; to divide a ' +
            'line, add the moved amount as a new line on the target shipment and reduce the ' +
            'original. Anything that splits quantities has to do both halves itself.\n' +
            '• Cart writes can’t run in parallel — the platform rejects overlapping writes with a ' +
            'version conflict, and several of them (delivery-method changes, item adds, and the ' +
            'delivery-method recompute after moving the first item into a shipment) finish ' +
            'asynchronously and read back stale for a few seconds. A bulk apply should sequence its ' +
            'writes and confirm each has landed before the next, rather than firing them all and ' +
            'refreshing once.\n' +
            '• Do not bulk-delete a shipment that still holds items. Deleting a non-empty shipment ' +
            'makes the platform reflow its items into the default shipment asynchronously and as ' +
            'separate duplicate lines (it never merges them into the existing same-product line), ' +
            'and the timing is non-deterministic — reconciling those duplicates after the fact only ' +
            'sometimes works. Empty a shipment (move or remove its items) first, then delete it.';
        // Toggle: pressing the button again dismisses the message.
        this.info = this.info === msg ? undefined : msg;
    }

    handlePhasedDelivery() {
        const msg =
            'Phased delivery would turn one line into a schedule of dated shipments (e.g. a quantity ' +
            'of 12 becomes one shipment a month for a year), setting the dates automatically. It is ' +
            'not a subscription — the order already exists.\n\n' +
            'Design advice:\n' +
            '• Requested delivery date is asymmetric: you can set it through the normal update ' +
            'call, but you cannot clear it that way — the API silently ignores a null and rejects ' +
            'an empty value. Removing or resetting a date needs a direct Apex update, so plan the ' +
            'scheduler around that.\n' +
            '• Dividing the quantity into phases can’t use a relocate/arrange call — that only ' +
            'moves whole lines. Create each phase by adding its quantity as a new line on that ' +
            'phase’s shipment and reducing the source, and expect those adds to complete ' +
            'asynchronously: verify each has landed before creating the next.';
        // Toggle: pressing the button again dismisses the message.
        this.info = this.info === msg ? undefined : msg;
    }

    handleConfirm() {
        if (this.shipments.some((s) => s.items.length === 0)) {
            this.error =
                'Every shipment needs at least one item. Add items to (or remove) any empty shipment before continuing.';
            return;
        }
        // Navigate in the SAME tab: NavigationMixin to a standard__webPage opened the checkout in a
        // new tab on the LWR site, so assign window.location to keep the buyer in their current tab.
        window.location.assign(this.checkoutUrl);
    }

    // ---------- view model ----------

    // True while any cart write is in flight: the affected shipment(s) are grayed AND the managed
    // Cart Summary totals are still catching up (we call refreshCartSummary only AFTER our settle,
    // so totals lag the optimistic edit by the recompute window). Drives a small non-blocking
    // "updating totals" status so the buyer knows the numbers in the Cart Summary panel are
    // recalculating rather than wrong.
    get summarySyncing() {
        return this.pendingIds.length > 0 || this.creating;
    }

    get viewShipments() {
        const multi = this.multiMode;
        return this.shipments.map((s) => {
            // Rich labels (name + where + when, not just "Shipment 2") for BOTH the "Move to…" and
            // the split target dropdowns, so the buyer sees exactly which shipment they're moving to.
            const targets = this.shipments
                .filter((o) => o.id !== s.id)
                .map((o) => ({ label: `${o.name} — ${o.shortAddress} · ${o.dateLabel}`, value: o.id }));
            return {
                ...s,
                pending: this.pendingIds.includes(s.id),
                pendingClass: this.pendingIds.includes(s.id) ? 'ss-shipment ss-pending' : 'ss-shipment',
                dateInputId: `ss-date-${s.id}`,
                methodInputId: `ss-method-${s.id}`,
                editingAddress: this.editingAddressShipmentId === s.id,
                hasDate: !!s.desiredDeliveryDate,
                // mark the currently-selected method so the native <select> shows it
                methodOptions: s.methodOptions.map((m) => ({ ...m, selected: m.value === s.selectedMethodId })),
                isEmpty: s.items.length === 0,
                // Address is set but methods haven't come back yet (async recompute) — distinct
                // from having no address at all, so the hint can say the right thing.
                methodsLoading: !s.hasMethods && !!s.address,
                canMove: multi && targets.length > 0,
                // The trash shows for any non-default shipment (when more than one exists), but is
                // only ENABLED when the shipment is empty — deleting a shipment with items relies on
                // a fragile async platform reflow, so we make the buyer move items out first.
                showDelete: multi && !s.isDefault && this.shipments.length > 1,
                deleteDisabled: s.items.length > 0,
                deleteTitle:
                    s.items.length > 0
                        ? 'Move or remove all items out of this shipment before deleting it'
                        : 'Remove this shipment',
                items: s.items.map((it) => ({
                    ...it,
                    moveOptions: targets,
                    splitTargetOptions: targets,
                    atMinQty: it.quantity <= 1,
                    canSplit: multi && targets.length > 0 && it.quantity > 1,
                    canSplitAttempt: multi && targets.length > 0,
                    isSplitting: it.id === this.splittingItemId,
                    splitError: it.id === this.splittingItemId ? this.splitError : undefined,
                    splitMax: it.quantity - 1
                }))
            };
        });
    }

    // ---------- helpers ----------

    unitOf(item) {
        // recover the numeric unit price from the formatted extended amount / qty
        const extended = Number(String(item.amount).replace(/[^0-9.-]/g, ''));
        return item.quantity > 0 ? extended / item.quantity : 0;
    }

    findItem(groupId, cartItemId) {
        const g = this.shipments.find((s) => s.id === groupId);
        return g ? g.items.find((it) => it.id === cartItemId) : undefined;
    }

    // Total quantity of a product within a group, summed across any duplicate same-product lines.
    sumQty(group, productId) {
        if (!group) {
            return 0;
        }
        return group.items
            .filter((i) => i.productId === productId)
            .reduce((sum, i) => sum + i.quantity, 0);
    }

    addrLabel(a) {
        if (!a) {
            return 'No address yet';
        }
        return [a.name, a.street, a.city, a.region, a.postalCode].filter(Boolean).join(', ');
    }

    // Compact address for dense option labels (city/region, falling back to the name/street).
    shortAddr(a) {
        if (!a) {
            return 'No address';
        }
        const cityRegion = [a.city, a.region].filter(Boolean).join(', ');
        return cityRegion || a.name || a.street || 'No address';
    }

    money(v) {
        const n = Number(v);
        if (isNaN(n)) {
            return v;
        }
        return `$${n.toFixed(2)}`;
    }

    blankForm() {
        return { name: '', street: '', city: '', region: '', postalCode: '', country: 'US' };
    }

    msg(e) {
        return (e && e.body && e.body.message) || (e && e.message) || String(e);
    }

    sleep(ms) {
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
