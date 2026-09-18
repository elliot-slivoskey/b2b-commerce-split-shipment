/**
 * Controller for the custom split-shipment checkout LWC (c:b2bSplitShipment).
 *
 * Delivery-group create / arrange-items / update / delete are not exposed through
 * ConnectApi in Apex, so they go through an HTTP self-callout to the Connect REST
 * Commerce delivery-group APIs. The `effectiveAccountId` query param is required and
 * is the only account param the endpoint honors. All methods are cacheable=false so
 * UserInfo.getSessionId() returns a live session for the callout.
 *
 * Additive/reversible: this class does not modify any existing SPC class. Order
 * placement remains 100% native (sfdc_checkout__CartToOrder handles N delivery groups).
 */
public with sharing class SDO_B2BCommerce_SplitShipmentController {

    @TestVisible private static final String API_VERSION = 'v67.0';

    private class Ctx {
        String storeId;
        String accountId;
    }

    private static Ctx ctx(Id cartId) {
        WebCart c = [SELECT WebStoreId, AccountId FROM WebCart WHERE Id = :cartId LIMIT 1];
        Ctx x = new Ctx();
        x.storeId = c.WebStoreId;
        x.accountId = c.AccountId;
        return x;
    }

    private static String deliveryGroupsBase(Ctx x, Id cartId) {
        return System.Url.getOrgDomainUrl().toExternalForm()
            + '/services/data/' + API_VERSION
            + '/commerce/webstores/' + x.storeId
            + '/carts/' + cartId
            + '/delivery-groups';
    }

    private static String appendAccount(String url, Ctx x) {
        return url + (url.contains('?') ? '&' : '?') + 'effectiveAccountId=' + x.accountId;
    }

    /** Issues the callout and returns the body, throwing AuraHandledException on non-2xx. */
    private static String send(String verb, String url, String body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(url);
        req.setMethod(verb);
        req.setHeader('Authorization', 'Bearer ' + UserInfo.getSessionId());
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Accept', 'application/json');
        if (String.isNotBlank(body)) {
            req.setBody(body);
        }
        // Bound a stalled callout: if the platform stops responding mid-operation, fail in a
        // minute rather than hanging the UI (grayed shipments) for the 2-minute Apex max — the
        // LWC's finally-blocks then clear the pending state and surface the error for a retry.
        req.setTimeout(60000);
        HttpResponse res = new Http().send(req);
        Integer code = res.getStatusCode();
        if (code < 200 || code >= 300) {
            throw new AuraHandledException('Delivery-group call failed (' + code + '): ' + res.getBody());
        }
        return res.getBody();
    }

    /**
     * Resolves the cart to operate on when the component runs on a checkout page.
     * If the page already bound a cartId (e.g. via {!cartId}), it is returned as-is.
     * Otherwise the current buyer's in-progress cart for the store is looked up by owner.
     * communityId comes from the LWC via @salesforce/community/Id.
     */
    @AuraEnabled(cacheable=false)
    public static String resolveCartId(String communityId, String cartId) {
        if (String.isNotBlank(cartId)) {
            return cartId;
        }
        Id storeId = null;
        if (String.isNotBlank(communityId)) {
            List<WebStoreNetwork> wsn = [SELECT WebStoreId FROM WebStoreNetwork WHERE NetworkId = :communityId LIMIT 1];
            if (!wsn.isEmpty()) {
                storeId = wsn[0].WebStoreId;
            }
        }
        Id uid = UserInfo.getUserId();
        String q = 'SELECT Id FROM WebCart WHERE OwnerId = :uid AND Status IN (\'Checkout\', \'Active\')';
        if (storeId != null) {
            q += ' AND WebStoreId = :storeId';
        }
        q += ' ORDER BY LastModifiedDate DESC LIMIT 1';
        List<WebCart> carts = Database.query(q);
        if (carts.isEmpty()) {
            throw new AuraHandledException('No in-progress cart found for the current user.');
        }
        return carts[0].Id;
    }

    /**
     * One-shot state for the LWC: the cart's delivery groups (raw REST JSON), the
     * account's shipping address book, whether split shipment is enabled on the store,
     * and the cart currency. Returned as a JSON string the LWC parses.
     */
    @AuraEnabled(cacheable=false)
    public static String getState(String cartId) {
        try {
            Ctx x = ctx(cartId);
            String dgJson = send('GET', appendAccount(deliveryGroupsBase(x, cartId), x), null);

            WebStore store = [SELECT OptionsSplitShipmentEnabled FROM WebStore WHERE Id = :x.storeId LIMIT 1];

            // Shipping addresses only. ContactPointAddress.AddressType is a single-value picklist
            // ('Shipping' / 'Billing' / ...); an account typically has a Billing and a Shipping
            // record for the same location, so without this filter the picker shows every address
            // twice. This is a ship-to picker, so restrict to Shipping.
            List<Map<String, Object>> addresses = new List<Map<String, Object>>();
            for (ContactPointAddress cpa : [
                    SELECT Id, Name, Street, City, State, PostalCode, Country
                    FROM ContactPointAddress
                    WHERE ParentId = :x.accountId AND AddressType = 'Shipping'
                    ORDER BY Name
                    LIMIT 200]) {
                addresses.add(new Map<String, Object>{
                    'id' => cpa.Id,
                    'name' => cpa.Name,
                    'street' => cpa.Street,
                    'city' => cpa.City,
                    'region' => cpa.State,
                    'postalCode' => cpa.PostalCode,
                    'country' => cpa.Country
                });
            }

            Map<String, Object> state = new Map<String, Object>{
                'deliveryGroups' => JSON.deserializeUntyped(dgJson),
                'addressBook' => addresses,
                'splitShipmentEnabled' => store.OptionsSplitShipmentEnabled
            };
            return JSON.serialize(state);
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException('getState failed: ' + e.getMessage());
        }
    }

    /**
     * Creates a new delivery group with a ship-to address (required by the API).
     * addressJson is the deliveryAddress object, e.g.
     * {"street":"..","city":"..","region":"..","postalCode":"..","country":"..","firstName":"..","lastName":"..","name":".."}
     * Returns the created group JSON.
     */
    @AuraEnabled(cacheable=false)
    public static String createDeliveryGroup(String cartId, String name, String addressJson) {
        Ctx x = ctx(cartId);
        Map<String, Object> body = new Map<String, Object>();
        if (String.isNotBlank(name)) {
            body.put('name', name);
        }
        if (String.isNotBlank(addressJson)) {
            body.put('deliveryAddress', JSON.deserializeUntyped(addressJson));
        }
        return send('POST', appendAccount(deliveryGroupsBase(x, cartId), x), JSON.serialize(body));
    }

    /**
     * Assigns items to delivery groups. arrangementsJson is the JSON array the LWC builds
     * and is passed through verbatim under the "arrangements" key. The arrangement object
     * accepts ONLY {cartItemId, deliveryGroupId, quantity} — every nested form
     * (itemDistributions, distributions, quantities) is rejected with
     * JSON_PARSER_ERROR "Unrecognized field" (verified against the live org 2026-09-17).
     *   - Whole-line MOVE (relocate a cart item to one group):
     *       [{"deliveryGroupId":"0a7...","cartItemId":"0a9...","quantity":2}]
     *   - SPLIT (keep some in the source group, place the rest in another): two flat
     *     entries with the SAME cartItemId and different deliveryGroupIds:
     *       [{"deliveryGroupId":"0a7...","cartItemId":"0a9...","quantity":3},
     *        {"deliveryGroupId":"0a8...","cartItemId":"0a9...","quantity":2}]
     */
    @AuraEnabled(cacheable=false)
    public static String arrangeItems(String cartId, String arrangementsJson) {
        Ctx x = ctx(cartId);
        Object arrangements = JSON.deserializeUntyped(arrangementsJson);
        Map<String, Object> body = new Map<String, Object>{ 'arrangements' => arrangements };
        // NOTE: actions/arrange-items does NOT honor effectiveAccountId (returns 400 as admin);
        // it resolves the account solely from the buyer session context. The LWC runs as the
        // buyer, so we deliberately omit the account param here.
        // deleteEmptyDeliveryGroups=false: keep a shipment that has had all its items moved out,
        // so the buyer can still organize items into it (they can Remove it explicitly instead).
        String url = deliveryGroupsBase(x, cartId) + '/actions/arrange-items?deleteEmptyDeliveryGroups=false';
        return send('POST', url, JSON.serialize(body));
    }

    /**
     * Updates a delivery group. patchJson may contain any of: deliveryMethodId,
     * desiredDeliveryDate, shippingInstructions, name, deliveryAddress{...}.
     */
    @AuraEnabled(cacheable=false)
    public static String updateDeliveryGroup(String cartId, String deliveryGroupId, String patchJson) {
        Ctx x = ctx(cartId);
        String url = appendAccount(deliveryGroupsBase(x, cartId) + '/' + deliveryGroupId, x);
        return send('PATCH', url, patchJson);
    }

    /**
     * Updates the quantity of a cart item line (the +/- steppers). Runs as the buyer,
     * so the account resolves from the session; no effectiveAccountId is sent.
     * The platform recalculates line/shipping/tax totals natively.
     */
    @AuraEnabled(cacheable=false)
    public static String updateItemQuantity(String cartId, String cartItemId, Integer quantity) {
        Ctx x = ctx(cartId);
        String url = System.Url.getOrgDomainUrl().toExternalForm()
            + '/services/data/' + API_VERSION
            + '/commerce/webstores/' + x.storeId
            + '/carts/' + cartId
            + '/cart-items/' + cartItemId;
        Map<String, Object> body = new Map<String, Object>{ 'quantity' => String.valueOf(quantity) };
        return send('PATCH', url, JSON.serialize(body));
    }

    /**
     * Splits one cart-item line's quantity across two delivery groups.
     *
     * arrange-items only RELOCATES a whole line (a cart item lives in exactly one group;
     * two entries with the same cartItemId collapse to one), so it cannot split. Verified
     * against the live org: the split primitive is instead
     *   1) POST /cart-items with cartDeliveryGroupId=target  -> mints a distinct line in the
     *      target group (or merges if the product already has a line there), and
     *   2) PATCH the source line down to the remaining quantity.
     * We add to the target FIRST and reduce the source SECOND: if the second call fails, the
     * buyer is left with EXTRA (visible, recoverable) units rather than destroyed units.
     * The PATCH is idempotent (sets an absolute quantity), so it is safe to retry once on a
     * transient cart-version conflict; the ADD runs exactly once.
     */
    @AuraEnabled(cacheable=false)
    public static String splitCartItem(String cartId, String sourceCartItemId, String productId,
            String targetGroupId, Integer moveQty, Integer remainingQty) {
        Ctx x = ctx(cartId);
        String base = System.Url.getOrgDomainUrl().toExternalForm()
            + '/services/data/' + API_VERSION
            + '/commerce/webstores/' + x.storeId
            + '/carts/' + cartId;
        // 1) Add the moved quantity as its own line in the target group.
        Map<String, Object> addBody = new Map<String, Object>{
            'productId' => productId,
            'quantity' => String.valueOf(moveQty),
            'type' => 'Product',
            'cartDeliveryGroupId' => targetGroupId
        };
        String addResp = send('POST', base + '/cart-items', JSON.serialize(addBody));
        // 2) Reduce the source line to what remains (idempotent -> one retry on conflict).
        String patchUrl = base + '/cart-items/' + sourceCartItemId;
        String patchBody = JSON.serialize(new Map<String, Object>{ 'quantity' => String.valueOf(remainingQty) });
        try {
            send('PATCH', patchUrl, patchBody);
        } catch (AuraHandledException e) {
            String m = e.getMessage();
            if (m != null && (m.contains('(409)') || m.containsIgnoreCase('Version Mismatch') || m.containsIgnoreCase('Conflict'))) {
                send('PATCH', patchUrl, patchBody);
            } else {
                throw e;
            }
        }
        return addResp;
    }

    /**
     * Removes a single line item from the cart entirely (the per-line delete X).
     * Distinct from deleting a delivery group. Runs as the buyer; the platform
     * recalculates totals natively.
     */
    @AuraEnabled(cacheable=false)
    public static String deleteCartItem(String cartId, String cartItemId) {
        Ctx x = ctx(cartId);
        String url = System.Url.getOrgDomainUrl().toExternalForm()
            + '/services/data/' + API_VERSION
            + '/commerce/webstores/' + x.storeId
            + '/carts/' + cartId
            + '/cart-items/' + cartItemId;
        return send('DELETE', url, null);
    }

    /**
     * Adds `quantity` of a product as a line in a specific delivery group (used by Undo to
     * restore a removed line, and available for other add-to-group needs). Mirrors the split
     * primitive: cartDeliveryGroupId places the line in the target group (merging only if that
     * same product already has a line there).
     */
    @AuraEnabled(cacheable=false)
    public static String addItemToGroup(String cartId, String productId, Integer quantity, String deliveryGroupId) {
        Ctx x = ctx(cartId);
        String url = System.Url.getOrgDomainUrl().toExternalForm()
            + '/services/data/' + API_VERSION
            + '/commerce/webstores/' + x.storeId
            + '/carts/' + cartId + '/cart-items';
        Map<String, Object> body = new Map<String, Object>{
            'productId' => productId,
            'quantity' => String.valueOf(quantity),
            'type' => 'Product'
        };
        if (String.isNotBlank(deliveryGroupId)) {
            body.put('cartDeliveryGroupId', deliveryGroupId);
        }
        return send('POST', url, JSON.serialize(body));
    }

    /**
     * Moves a line into a target group that ALREADY contains the same product, merging the
     * quantities into ONE line.
     *
     * POST /cart-items with cartDeliveryGroupId=<non-default target> MINTS A DISTINCT line even
     * when that same product already has a line in the target group (verified live 2026-09-18 —
     * the "merge on add" behavior only holds for the DEFAULT group), and arrange-items likewise
     * leaves two separate same-product lines. So neither add-then-delete nor relocate merges.
     * Instead we PATCH the target's EXISTING line up to the summed quantity and then delete the
     * source line. Bump first, delete second: a mid-failure leaves extra (recoverable) units
     * rather than losing any. The PATCH sets an absolute quantity (idempotent), so it is safe to
     * retry once on a transient cart-version conflict.
     */
    @AuraEnabled(cacheable=false)
    public static String moveItemMerge(String cartId, String sourceCartItemId,
            String targetCartItemId, Integer newQuantity) {
        Ctx x = ctx(cartId);
        String base = System.Url.getOrgDomainUrl().toExternalForm()
            + '/services/data/' + API_VERSION
            + '/commerce/webstores/' + x.storeId
            + '/carts/' + cartId + '/cart-items/';
        // 1) Bump the existing target line to the combined quantity (idempotent -> one retry).
        String patchBody = JSON.serialize(new Map<String, Object>{ 'quantity' => String.valueOf(newQuantity) });
        try {
            send('PATCH', base + targetCartItemId, patchBody);
        } catch (AuraHandledException e) {
            String m = e.getMessage();
            if (m != null && (m.contains('(409)') || m.containsIgnoreCase('Version Mismatch') || m.containsIgnoreCase('Conflict'))) {
                send('PATCH', base + targetCartItemId, patchBody);
            } else {
                throw e;
            }
        }
        // 2) Remove the source line now that its quantity lives in the target line.
        send('DELETE', base + sourceCartItemId, null);
        return '{}';
    }

    /**
     * Clears a delivery group's requested date (the "ASAP" action). The Connect REST PATCH
     * IGNORES a null desiredDeliveryDate (returns 200 but leaves the value), and empty string
     * is a 400 — verified against the live org — so the only way to unset it is a direct DML.
     * Buyers have no CRUD on CartDeliveryGroup, but Apex enforces CRUD/FLS only when asked, so
     * a system-mode `without sharing` DML clears the field for the buyer.
     */
    @AuraEnabled(cacheable=false)
    public static void clearDesiredDate(String deliveryGroupId) {
        new Elevated().clearDate((Id) deliveryGroupId);
    }

    private without sharing class Elevated {
        void clearDate(Id dgId) {
            update new CartDeliveryGroup(Id = dgId, DesiredDeliveryDate = null);
        }
    }

    /**
     * Merges duplicate same-product lines within each delivery group into a single line.
     *
     * Deleting a delivery group with deleteCartItems=false reflows its items into the DEFAULT
     * group as SEPARATE lines — the platform does NOT merge them with an existing same-product
     * line there (verified live 2026-09-18: default ended with two Wind Generator lines, 2 + 2,
     * instead of one line of 4). Those extra lines read to the buyer as units "hidden in the
     * background." For each group, for each product that has more than one line, this PATCHes the
     * first line up to the summed quantity and DELETEs the rest. Idempotent: a no-op when there
     * are no duplicates, so it is safe to call after any reflow. Returns the number of lines
     * removed by THIS call (0 = nothing left to consolidate). Runs as the buyer, so cart-item
     * writes resolve the account from the session (no effectiveAccountId); the delivery-groups GET
     * keeps it, matching getState.
     *
     * CHUNKED: each call runs in one Apex transaction bounded by the 100-callout governor limit. A
     * deleted shipment on a large cart can reflow dozens of overlapping SKUs, each adding a
     * duplicate line, so this caps its WRITE callouts per call (leaving headroom for the GET and
     * any 409 retries) and returns early with the merges done so far. Only the duplicate units it
     * actually deletes this call are folded into the keeper's quantity, so the running totals stay
     * correct across calls. The LWC calls this repeatedly until it returns 0.
     */
    @AuraEnabled(cacheable=false)
    public static Integer consolidateGroups(String cartId) {
        final Integer WRITE_BUDGET = 80;
        Ctx x = ctx(cartId);
        String dgJson = send('GET', appendAccount(deliveryGroupsBase(x, cartId), x), null);
        Map<String, Object> dg = (Map<String, Object>) JSON.deserializeUntyped(dgJson);
        List<Object> groups = (List<Object>) dg.get('items');
        if (groups == null) {
            return 0;
        }
        String ciBase = System.Url.getOrgDomainUrl().toExternalForm()
            + '/services/data/' + API_VERSION
            + '/commerce/webstores/' + x.storeId
            + '/carts/' + cartId + '/cart-items/';
        Integer removed = 0;
        Integer writes = 0;
        for (Object go : groups) {
            Map<String, Object> g = (Map<String, Object>) go;
            Map<String, Object> ci = (Map<String, Object>) g.get('cartItems');
            if (ci == null) {
                continue;
            }
            List<Object> lines = (List<Object>) ci.get('cartItems');
            if (lines == null) {
                continue;
            }
            // Per product: the line we keep + its quantity, and the duplicate lines with theirs.
            Map<String, String> keeperId = new Map<String, String>();
            Map<String, Decimal> keeperQty = new Map<String, Decimal>();
            Map<String, List<String>> extraIds = new Map<String, List<String>>();
            Map<String, Decimal> lineQty = new Map<String, Decimal>();
            for (Object lo : lines) {
                Map<String, Object> it = (Map<String, Object>) ((Map<String, Object>) lo).get('cartItem');
                String pid = String.valueOf(it.get('productId'));
                String lineId = String.valueOf(it.get('cartItemId'));
                Decimal q = Decimal.valueOf(String.valueOf(it.get('quantity')));
                if (!keeperId.containsKey(pid)) {
                    keeperId.put(pid, lineId);
                    keeperQty.put(pid, q);
                    extraIds.put(pid, new List<String>());
                } else {
                    extraIds.get(pid).add(lineId);
                    lineQty.put(lineId, q);
                }
            }
            for (String pid : keeperId.keySet()) {
                List<String> extras = extraIds.get(pid);
                if (extras.isEmpty()) {
                    continue;
                }
                // Reserve one callout for the keeper PATCH, then delete as many duplicates as the
                // remaining budget allows this call, folding ONLY those units into the keeper so the
                // running quantity is correct even when the rest is deferred to a later call.
                Integer available = WRITE_BUDGET - writes - 1;
                if (available <= 0) {
                    return removed; // budget spent — the LWC will call again to finish
                }
                Integer take = Math.min(available, extras.size());
                Decimal newQty = keeperQty.get(pid);
                List<String> toDelete = new List<String>();
                for (Integer i = 0; i < take; i++) {
                    String ex = extras.get(i);
                    newQty += lineQty.get(ex);
                    toDelete.add(ex);
                }
                // Bump the keeper up FIRST, then delete the folded-in duplicates: a mid-failure
                // leaves extra (recoverable) units rather than losing any. The PATCH sets an
                // absolute quantity (idempotent), so it is safe to retry once on a conflict.
                String patchBody = JSON.serialize(new Map<String, Object>{
                    'quantity' => newQty.stripTrailingZeros().toPlainString()
                });
                try {
                    send('PATCH', ciBase + keeperId.get(pid), patchBody);
                } catch (AuraHandledException e) {
                    String m = e.getMessage();
                    if (m != null && (m.contains('(409)') || m.containsIgnoreCase('Version Mismatch') || m.containsIgnoreCase('Conflict'))) {
                        send('PATCH', ciBase + keeperId.get(pid), patchBody);
                    } else {
                        throw e;
                    }
                }
                writes++;
                for (String extraId : toDelete) {
                    send('DELETE', ciBase + extraId, null);
                    writes++;
                    removed++;
                }
                if (take < extras.size()) {
                    return removed; // more duplicates of this product remain — finish next call
                }
            }
        }
        return removed;
    }

    /**
     * Deletes a delivery group. Items in it are moved to the default group (deleteCartItems=false).
     * A delete firing close behind another async cart write can hit a transient cart-version
     * conflict (409) — verified live 2026-09-18, where the first DELETE returned 409 and a retry
     * succeeded. DELETE is safe to retry once here: on a 409 the group still exists, so the retry
     * deletes it (a genuinely-already-deleted group would surface as 404, not 409).
     */
    @AuraEnabled(cacheable=false)
    public static String deleteDeliveryGroup(String cartId, String deliveryGroupId) {
        Ctx x = ctx(cartId);
        String url = appendAccount(
            deliveryGroupsBase(x, cartId) + '/' + deliveryGroupId + '?deleteCartItems=false', x);
        try {
            return send('DELETE', url, null);
        } catch (AuraHandledException e) {
            String m = e.getMessage();
            if (m != null && (m.contains('(409)') || m.containsIgnoreCase('Version Mismatch') || m.containsIgnoreCase('Conflict'))) {
                return send('DELETE', url, null);
            }
            throw e;
        }
    }
}
