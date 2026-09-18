# Readme for Humans - B2B Commerce Split Shipment

A custom checkout component for **Salesforce B2B Commerce (Enhanced / LWR)** that lets a 
buyer split a single cart across **multiple shipments**. This is a different take on the
out of the box split shipment functionality that existed in **September 2026**. 

It replaces the managed "Split Shipment" component (which usually lives in it's own page)
with a different version- thus it should have non-destructive behavior with your checkout.
Tested with one page checkout only.

## Why this was built
The reference component organizes the UX with items as the parent object and shipments
as children. I think it's much more logical to lay this out with parent shipments and
child items. This will be especially true for large orders (not to mention the vertical
space inefficiency of the reference component.)

You also gain the ability to set the ship method and requested ship date per shipment.

This component would also make a great starting point for anyone who wants to make a
'bulk editor' or a 'phased delivery scheduler' but I did not publish that here as
I think there are too many different ways that design could be interpreted.

## Why this was published
This allows you to consider my perspective of how B2B buyers operate.
I also encountered lots of **undocumented platform behaviors** which required many
more instances of iterations than I expected for such a simple feature.
These are written up in detail below and aren't in Salesforce's documentation.

## Video Preview
<img width="1154" height="719" alt="Kapture 2026-09-18 at 15 46 39" src="https://github.com/user-attachments/assets/4440dbf4-4925-401d-b964-2f3185331179" />

---

# Readme for Agents - B2B Commerce Split Shipment

## What's in the repo

| Metadata | Path | Purpose |
| --- | --- | --- |
| `SDO_B2BCommerce_SplitShipmentController` (Apex) | `force-app/main/default/classes/` | Server-side bridge to the Connect REST Commerce cart / delivery-group APIs via an authenticated self-callout. All cart mutations funnel through here. |
| `b2bSplitShipment` (LWC) | `force-app/main/default/lwc/b2bSplitShipment/` | The main checkout component — the shipment editor. |
| `b2bSplitShipmentOverview` (LWC) | `force-app/main/default/lwc/b2bSplitShipmentOverview/` | A companion summary panel that stays in sync with the editor over Lightning Message Service. |
| `SplitShipmentSync` (Message Channel) | `force-app/main/default/messageChannels/` | LMS channel the two components use to stay in sync. |
| `SplitShipment_SelfCallout` (Remote Site Setting) | `force-app/main/default/remoteSiteSettings/` | Authorizes the Apex self-callout back to your org's Commerce REST endpoints. |

> The Apex class keeps the `SDO_B2BCommerce_` prefix to match the naming convention of a
> Salesforce demo (SDO) org, but it is entirely custom code, not a Salesforce sample.

---

## How it works

- The **LWC** renders the cart's delivery groups as "shipments." Every buyer action (add
  shipment, move item, split item, change address / method / date, delete shipment) calls an
  `@AuraEnabled` method on the Apex controller.
- The **Apex controller** does not use a supported server-side cart SDK — there isn't a full
  one for these operations — so it makes an **HTTP self-callout** to the org's own Connect
  REST Commerce endpoints (`/commerce/webstores/{store}/carts/{cart}/...`), authenticated with
  `Authorization: Bearer <UserInfo.getSessionId()>`. That's why a **Remote Site Setting** is
  required.
- A Salesforce **delivery group** == a shipment. Splitting the cart == creating delivery
  groups and arranging cart items across them.
- The **overview panel** subscribes to the `SplitShipmentSync` LMS channel; the editor
  publishes on it after each change so the summary redraws without its own round-trip.

---

## Prerequisites

- A **Salesforce B2B Commerce (Enhanced)** store on an **LWR** (Lightning Web Runtime)
  Experience Cloud site — this does **not** work on Aura/Visualforce storefronts.
- **Split shipping enabled** on the store: `WebStore.OptionsSplitShipmentEnabled = true`, plus
  the store's delivery/shipping sample Apex updated per Salesforce's
  [Enable Split Shipping](https://help.salesforce.com/s/articleView?id=commerce.comm_enable_split_shipping_for_commerce_stores.htm&type=5)
  guide.
- A buyer account/contact that can reach checkout with a cart that has items.
- **API version 67.0+** (the callouts target `v67.0`).
- `sf` CLI (Salesforce CLI) authenticated to the target org, or the ability to deploy metadata
  another way.

---

## Install

These steps target a **scratch org or sandbox / demo (SDO) org you control** — deploy to a
dev environment first, never straight to production. If you're an agent installing this for
someone, follow them in order and stop to confirm the two config edits.

### 1. Clone and set the two org-specific values

Two files contain a **placeholder for your org's My Domain** that you must replace before
deploying, because the callout target and the checkout return URL are org-specific:

- `force-app/main/default/remoteSiteSettings/SplitShipment_SelfCallout.remoteSite-meta.xml`
  → set `<url>` to your org's domain, e.g. `https://acme-dev.my.salesforce.com`.
- `force-app/main/default/lwc/b2bSplitShipment/b2bSplitShipment.js-meta.xml`
  → set the `checkoutUrl` property `default` to your store's checkout URL, e.g.
  `https://acme-dev.my.site.com/mystore/checkout`. (This is also editable per-placement in
  the Experience Builder property panel — see [Configuration](#configuration).)

Placeholders to find and replace: `YOUR_MYDOMAIN` and `YOUR_STORE_PATH`.

```bash
grep -rn "YOUR_MYDOMAIN\|YOUR_STORE_PATH" force-app
```

The default value in `b2bSplitShipment.js` itself is only a fallback; the meta.xml default
and the Experience Builder property are what actually apply at runtime.

### 2. Deploy the metadata

```bash
# authenticate first, e.g.:  sf org login web --alias mydev
sf project deploy start --target-org mydev
```

Or deploy only this project's directory:

```bash
sf project deploy start --source-dir force-app --target-org mydev
```

### 3. Confirm the Remote Site Setting is active

Setup → **Remote Site Settings** → `SplitShipment_SelfCallout` should be **Active** and point
at your My Domain. Without it, every cart operation fails with an unauthorized-endpoint
callout error.

### 4. Place the components on the checkout page

In **Experience Builder** for your store:

1. Open the **Checkout** page.
2. Drag **`b2bSplitShipment`** into the split-shipment step (replacing the managed split
   component, or on your own checkout layout).
3. Optionally drag **`b2bSplitShipmentOverview`** into a summary column.
4. Select `b2bSplitShipment` and set the **Checkout URL** property to your store's checkout
   URL if the default doesn't match.

### 5. Republish the site  ← don't skip this

**LWR sites do not serve LWC changes until the site is republished.** After any deploy that
touches these components, click **Publish** in Experience Builder. A deploy alone will make
it look like nothing changed on the live site.

### 6. Smoke test

As a buyer, reach checkout with a multi-item cart and: add a shipment, move an item, split an
item's quantity, set a per-shipment address/method/date, empty a shipment and delete it (the
trash is disabled until the shipment has no items — see undocumented behavior #4 for why), then
**Confirm and return to checkout** (should navigate in the **same tab**).

---

## Configuration

| Where | Setting | Notes |
| --- | --- | --- |
| Experience Builder property panel | **Checkout URL** | Where "Confirm and return to checkout" navigates. Set per placement. |
| `b2bSplitShipment.js-meta.xml` | `checkoutUrl` default | Fallback if the property is left blank. |
| Remote Site Setting | `<url>` | Your org's My Domain; the callout target. |

---

## Undocumented behaviors

These are the platform behaviors that aren't documented (or are documented misleadingly) and
that this component works around. If you extend it — or build anything else on the Commerce
cart / delivery-group APIs — read this section first. It will save you the live-probing it took
to find them.

### 1. "Merge on add" only happens in the *default* delivery group
`POST /cart-items` with a `cartDeliveryGroupId` pointing at a **non-default** group **mints a
brand-new line even if that product already has a line in that group.** The merge-into-existing
behavior everyone assumes is global only holds for the **default** group. Consequence: to add
quantity to an existing line in a custom shipment you must **PATCH the existing line's quantity**,
not POST an add — otherwise you get two lines of the same SKU that *look* like the quantity
vanished.

### 2. There is no "split" API
`arrange-items` (the relocate API) moves a **whole line** to another delivery group. Two
arrangements with the same `cartItemId` collapse to one and the extra units are **destroyed**.
So splitting a line's quantity across shipments is a **two-step primitive you assemble yourself**:
1. `POST /cart-items` with the moved quantity and the target `cartDeliveryGroupId` (mints a new
   line in the target), then
2. `PATCH /cart-items/{sourceId}` to reduce the source line.

**Always add first, reduce second** — a mid-sequence failure then leaves *extra recoverable*
units, never destroyed ones.

### 3. Requested delivery date is asymmetric — you can set it but not clear it via REST
`PATCH`ing `desiredDeliveryDate` to a value works. But:
- `desiredDeliveryDate: null` returns 200 and is a **silent no-op** (the date is not cleared).
- `desiredDeliveryDate: ""` returns **400** (`JSON_PARSER_ERROR`).

The **only** way to clear a requested date is a **direct Apex DML** update
(`update new CartDeliveryGroup(Id=.., DesiredDeliveryDate=null)`). Apex runs in system mode for
CRUD/FLS, so a `without sharing` method clears it fine even for a buyer whose profile has no
edit access to `CartDeliveryGroup`. This component isolates that in a dedicated elevated method.

### 4. Deleting a shipment reflows items back as *duplicate* lines, asynchronously — so this component only lets you delete an *empty* shipment
`DELETE /delivery-groups/{id}?deleteCartItems=false` moves the group's items into the **default**
group, but as **separate new lines** — it does **not** merge them with the default's existing
same-SKU line. Delete a group holding 3 of a product when the default already has 2, and the
default ends with **two** lines (`2` and `3`), not one line of `5`. Those extra lines read to the
buyer as quantity that has "disappeared into the background." Worse, the reflow is **202 async
and slow** — it can land *after* a refresh, so whether the duplicates even surface in time is
timing-dependent.

**Why delete is the fragile operation and move/split are not:** move and split use primitives
where *we* name the exact target line, so the merge is explicit and instant. A deleted group
hands its items to the **platform**, which reflows them into the default group asynchronously,
slowly, and as their own new lines — so both the timing and the (non-)merge are out of our
control.

**The design decision.** An earlier version tried to *reconcile* this after the fact: wait for
every unit to reflow, then consolidate the duplicate lines server-side (PATCH a keeper line up to
the summed quantity, DELETE the rest — bounded against the **100-callout** governor limit and
looped for large carts). It worked when the reflow was fast, but was **non-deterministic**: when
the platform was slow, consolidation ran against a half-finished reflow and left duplicates behind
("sometimes merges, sometimes not"). So the component now **removes the fragile path entirely —
the delete (trash) control is disabled until a shipment is empty**, with a visible hint telling
the buyer to move or remove its items first. An empty group has nothing to reflow, so the delete
is instant and reliable. (The Apex `consolidateGroups` method is left in the controller as an
idempotent safety utility but is no longer called by the UI.) If you re-enable deleting
non-empty shipments, you re-inherit the async-reconciliation problem — don't, unless you can
tolerate that nondeterminism.

### 5. Cart writes can't run in parallel, and many read back stale
Overlapping cart writes are rejected with a **version conflict (409 / "Version Mismatch")**.
Several writes are **202 async** and read back stale for a few seconds — notably `deliveryMethodId`
(the immediate GET still shows the old method), item adds, and — easy to miss — a group's
**`availableDeliveryMethods` recompute** when the *first* item lands in a freshly-created
shipment. A single refetch reads that back empty, so the method row briefly renders its
"no methods yet" state against a shipment that already has an address. Rules this component
follows and you should too:
- **Sequence** cart writes; never fire them concurrently.
- **Retry on 409, with a delay.** A retry is safe (the write hadn't applied; an already-applied
  delete returns 404, not 409). But an *immediate* retry isn't enough when the conflict is a
  `409 CHECKOUT_CONFLICT` "Checkout calculations are still running" — that happens when a delete
  (or any write) fires while the platform is still recalculating a change that just completed, and
  it needs a moment. This component retries the shipment delete with a **growing backoff**
  (1.5s / 3s / 4.5s) rather than once immediately.
- **Confirm each write landed** (poll / reload) before depending on it — including waiting for a
  moved-into group's delivery methods to recompute — and update the UI **optimistically** rather
  than trusting an immediate re-fetch.

### 6. Native form controls, not `lightning-*`, for the method / date row
The method and requested-date fields are **native `<select>` / `<input type="date">`** styled to
look like SLDS, not `lightning-combobox` / `lightning-input`. Reasons: the Lightning components
reserve a ~33% inline **label column inside their shadow DOM** that LWC CSS can't reach (breaking
the label-alignment/reflow this layout needs), and the native date picker floats instead of
adding the inline format-hint line that expanded the row. **Trade-off:** a native `<select>`
**cannot render multi-line rich options** the way the OOTB selector does — so the "move to" /
"split to" dropdowns show an enriched single-line label (`Shipment name — address · date`) rather
than a multi-line card. A fully custom SLDS listbox would be the only way to match the OOTB rich
options, if that ever matters.

> Native date inputs also emit **premature `change` events** as the user types the year (e.g.
> `0002-01-01`), which the delivery-group PATCH rejects. The date handler guards on a full
> `^\d{4}-\d{2}-\d{2}$` match with year ≥ 1000 before writing.

### 7. Admin-vs-buyer session quirks (only relevant if you probe/script against a live cart)
Running these APIs as an **admin** against a **buyer's** cart requires `?effectiveAccountId=<cartAccount>`
on reads and on `cart-items` writes (a `cart-items` write without it returns 400
`INVALID_INPUT_COMBINATION`). As the **buyer at runtime**, `cart-items` writes need **no**
`effectiveAccountId` (the session resolves the account), and `arrange-items` **only** works as the
buyer (admin gets `INVALID_API_INPUT accountId` even with `effectiveAccountId`). This component's
runtime methods are buyer-session and omit `effectiveAccountId` on cart-item writes accordingly.

### 8. The managed "Cart Summary" totals go stale — refresh it with `commerce/cartApi`
The managed **Cart Summary** panel (subtotal / shipping / tax / grand total) reads its numbers from
a **client-side reactive cart store** via the `CartSummaryAdapter` wire in the **`commerce/cartApi`**
module. That store only invalidates when *it* performs the mutation. Because this component mutates
the cart **out-of-band** through the Apex/Connect REST callout, the store never learns the cart
changed — so the totals stay stale until a full reload or a checkout-step navigation.

The supported fix is the imperative **`refreshCartSummary()`** from `commerce/cartApi`
(`import { refreshCartSummary } from 'commerce/cartApi';`) — no arguments, returns a Promise,
callable from any custom LWC on the store page (no checkout mixin required). There is **no** LMS
channel that pokes the managed panel, so an LMS message can't do it.

**Critical ordering.** `refreshCartSummary()` only **re-reads already-computed totals — it does not
itself trigger the server pricing/tax/shipping recalc.** That recalc is kicked off by your cart
write and runs **asynchronously**. So call it **only after your change has settled** (this component
already polls with `loadStateUntil` until the write lands), otherwise the panel re-reads
mid-calculation values. This component wraps it in `refreshManagedCartSummary()` — called after each
mutation's settle — that (a) swallows errors so a refresh hiccup never breaks the successful cart
write, and (b) is timeout-capped so a hung store refresh can't leave a shipment grayed. While a
change is in flight the component shows a small non-blocking "Updating order totals…" status,
because the managed panel is a separate component we can't put a spinner inside.

### 9. The address book must be filtered to shipping addresses
`ContactPointAddress.AddressType` is a single-value picklist (`Shipping` / `Billing` / …). An
account typically stores the **same location twice** — one `Billing` record and one `Shipping`
record — so an unfiltered `ContactPointAddress WHERE ParentId = <account>` query returns every
address twice in a ship-to picker. The controller filters `AddressType = 'Shipping'`. (If your
data leaves `AddressType` null on addresses buyers should be able to ship to, widen the filter to
`AddressType = 'Shipping' OR AddressType = null`.)

---

## Known limitations

- **Bulk Edit** and **Phased Delivery** are surfaced in the UI as **"Not yet available"**
  placeholders. Design notes for whoever builds them are embedded in the component itself.
- **"Move to" / "Split to" dropdowns** show enriched single-line labels, not OOTB-style
  multi-line rich cards (see undocumented behavior #6).
- Requires an LWR B2B Commerce store with split shipping enabled — not portable to Aura
  storefronts.

## Safety / rollback

- Every operation is **additive and reversible** at the metadata level: the components and the
  Remote Site Setting can be deleted to fully remove the feature. Deploy to a **dev/sandbox/SDO**
  org first and test the full add / move / split / delete / confirm cycle before touching any
  environment that matters.
- Checkout is delicate — payment, tax, and the downstream Order Management integration all sit
  around this. This component only manipulates cart delivery groups and items via supported REST
  operations; it does not touch pricing, payment, or order creation. Keep it that way when you
  extend it.
