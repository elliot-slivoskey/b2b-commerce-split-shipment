import { LightningElement, api, track, wire } from 'lwc';
import { subscribe, unsubscribe, MessageContext } from 'lightning/messageService';
import SPLIT_SHIPMENT_SYNC from '@salesforce/messageChannel/SplitShipmentSync__c';
import COMMUNITYID from '@salesforce/community/Id';
import resolveCartId from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.resolveCartId';
import getState from '@salesforce/apex/SDO_B2BCommerce_SplitShipmentController.getState';

export default class B2bSplitShipmentOverview extends LightningElement {
    @api cartId;
    @api cardTitle = 'Shipment overview';

    @track shipments = [];
    loading = true;
    error;
    subscription;
    // groupId -> chosen method label, applied on top of server data until the async
    // deliveryMethodId change is reflected in a refetch (the PATCH is 202/eventual).
    methodOverrides = {};

    @wire(MessageContext) messageContext;

    connectedCallback() {
        this.subscription = subscribe(this.messageContext, SPLIT_SHIPMENT_SYNC, (msg) => this.onSync(msg));
        this.refresh();
    }

    onSync(msg) {
        if (msg && msg.method && msg.method.groupId) {
            this.methodOverrides[msg.method.groupId] = msg.method.label;
        }
        this.load();
    }

    disconnectedCallback() {
        if (this.subscription) {
            unsubscribe(this.subscription);
            this.subscription = undefined;
        }
    }

    async refresh() {
        this.loading = true;
        try {
            await this.load();
            this.error = undefined;
        } catch (e) {
            this.error = this.msg(e);
        }
        this.loading = false;
    }

    async load() {
        if (!this.cartId) {
            this.cartId = await resolveCartId({ communityId: COMMUNITYID, cartId: this.cartId });
        }
        const s = JSON.parse(await getState({ cartId: this.cartId }));
        const groups = (s.deliveryGroups && s.deliveryGroups.items) || [];
        const mapped = this.numberShipments(this.sortShipments(groups.map((g) => this.mapGroup(g))));
        // Apply any optimistic method labels; drop an override once the server agrees.
        this.shipments = mapped.map((row) => {
            const ov = this.methodOverrides[row.id];
            if (!ov) {
                return row;
            }
            if (row.methodLabel === ov) {
                delete this.methodOverrides[row.id];
                return row;
            }
            return { ...row, methodLabel: ov };
        });
    }

    // Mirror the editor: the shipment number is a positional display label (default = 1, then
    // 2..N by id order), not the server-stored group name — so the summary stays sequential and
    // matches the editor after a middle shipment is deleted and a new one created.
    numberShipments(sorted) {
        sorted.forEach((s, i) => {
            s.name = `Shipment ${i + 1}`;
        });
        return sorted;
    }

    // Match the main component's ordering: default shipment first, newest at the bottom.
    sortShipments(list) {
        return [...list].sort((a, b) => {
            if (a.isDefault !== b.isDefault) {
                return a.isDefault ? -1 : 1;
            }
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
    }

    mapGroup(g) {
        const wraps = (g.cartItems && g.cartItems.cartItems) || [];
        let count = 0;
        let subtotal = 0;
        wraps.forEach((w) => {
            const it = w.cartItem || {};
            count += Number(it.quantity) || 0;
            subtotal += Number(it.totalAmount != null ? it.totalAmount : it.totalPrice) || 0;
        });
        const method = g.selectedDeliveryMethod;
        return {
            id: g.id,
            // Overwritten with a positional label in numberShipments().
            name: g.name,
            isDefault: g.isDefault === true,
            addressLabel: this.addrLabel(g.deliveryAddress),
            itemCount: count,
            subtotal: this.money(subtotal),
            methodLabel: method ? `${method.name} — ${this.money(method.shippingFee)}` : 'Not selected'
        };
    }

    get hasShipments() {
        return this.shipments.length > 0;
    }

    addrLabel(a) {
        if (!a) {
            return 'No address yet';
        }
        return [a.name, a.street, a.city, a.region, a.postalCode].filter(Boolean).join(', ');
    }

    money(v) {
        const n = Number(v);
        return isNaN(n) ? v : `$${n.toFixed(2)}`;
    }

    msg(e) {
        return (e && e.body && e.body.message) || (e && e.message) || String(e);
    }
}
