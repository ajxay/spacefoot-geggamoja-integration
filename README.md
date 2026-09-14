# Geggamoja B2C Product API — Integration Guide for Spacefoot

**Document version:** 2.4  
**Last updated:** 2026-09-14  
**Audience:** Spacefoot Team (backend, integrations, data)  
**Author:** Victory Mantra (Shopify Developer for Geggamoja)  
**Status:** Draft for handoff — credentials provisioned by Victory Mantra / Geggamoja

> **Change from the previous document (v1.x):** The earlier guide described reading products from Geggamoja's **B2B** store (`geggamojab2b`) via catalog / publication / price-list APIs. **That model is superseded.** This document is **entirely B2C**: Spacefoot consumes the **Geggamoja B2C store** (`geggamoja`) Admin GraphQL API only. There is **no B2B API connection**. The B2B store is used only for **manual ordering** in the portal, not for product, price, or inventory data.

---

## 1. Purpose and scope

This document describes how **Spacefoot** can programmatically read **products**, **variants**, **inventory**, and **EUR pricing** from Geggamoja's **B2C** Shopify store (`geggamoja`) using the **Admin GraphQL API**, in order to **display Geggamoja products on Spacefoot's own site**.

> **Integration model (confirmed):** Spacefoot **fetches product data from the Geggamoja B2C store** and displays it on their storefront. When Spacefoot needs stock, they **place orders manually in the Geggamoja B2B portal** (`geggamojab2b`) as a regular B2B customer. There is **no automated order/checkout integration** — this API is **read-only product/inventory data** feeding Spacefoot's catalog.

### In scope

- Authentication and environment configuration for the Shopify **Admin GraphQL API** on the **B2C** store
- Listing the sellable product assortment (active / published products)
- Product content: titles, descriptions, image galleries, **material composition**, main color, tags
- Variants: SKU, barcode/EAN, options, inventory, pricing
- **EUR recommended retail / consumer selling price** for France via `contextualPricing(context: { country: FR })`
- Reading inventory quantities and sellability signals
- Pagination, rate limits, error handling, and recommended sync patterns

### Out of scope

- **Order placement, carts, checkout, fulfillment, payments, returns** — Spacefoot orders **manually via the B2B portal** (§13)
- **Write access** to products, prices, or inventory (Spacefoot's use is **read-only**)
- The Geggamoja **B2B** store product/catalog data (`geggamojab2b`) — used only for manual ordering, not for the product feed
- **Wholesale / purchase price in EUR** — not available via this integration; Spacefoot does not call the B2B APIs (see §7.3 / §13)

---

## 2. Business context

| Party | Role |
|--------|------|
| **Geggamoja** | Brand; sells via a Shopify **B2C** store (consumer) and a Shopify **B2B** store (wholesale) |
| **Victory Mantra** | Builds and operates Shopify stores / integrations for Geggamoja; provisions API credentials |
| **Spacefoot** | Distribution partner ([spacefoot.com](https://spacefoot.com/)) expanding Geggamoja into France. **Displays** Geggamoja products on its own site (data from the B2C store) and **buys** stock by ordering manually through the Geggamoja B2B portal |

**Store used for product data (B2C):** `geggamoja` → `geggamoja.myshopify.com`  
**Store used for ordering (B2B, manual only):** `geggamojab2b` — Spacefoot logs in as a B2B company account and places orders by hand; **not part of this API integration**.

**B2C store facts (live verification, Sep 2026):**

| Fact | Value |
|------|-------|
| Shop name | `Geggamoja` |
| `myshopifyDomain` | `geggamoja.myshopify.com` |
| Base currency | **SEK** |
| Total products | ~2,092 |
| **Active & published products (sellable assortment)** | **~875** |
| EUR pricing | Available via France market → `contextualPricing(context: { country: FR })` |

> The B2C store has no B2B-style "catalog / publication / price list". The assortment Spacefoot should import is simply the store's **active, published** products (§7.2).

---

## 3. Architecture overview

```text
┌─────────────────────┐      HTTPS POST (read)       ┌──────────────────────────────┐
│  Spacefoot          │  ───────────────────────►    │  Shopify Admin GraphQL API   │
│  integration        │  /admin/api/{version}/       │  store: geggamoja (B2C)      │
│  service            │        graphql.json          │                              │
│  (catalog on        │  ◄───────────────────────    │  Products · Variants ·       │
│   spacefoot.com)    │   products + EUR price        │  Inventory · EUR pricing     │
└─────────┬───────────┘                              └──────────────────────────────┘
          │
          │  places orders MANUALLY (human, in browser)
          ▼
┌──────────────────────────────┐
│  Geggamoja B2B portal        │   ← Spacefoot's B2B company account
│  store: geggamojab2b         │     (no API in this integration)
└──────────────────────────────┘

┌─────────────────────┐
│ Victory Mantra      │  provisions custom app + Admin API token on the B2C store
└─────────────────────┘
```

**Recommended data flow**

1. **Catalog sync (scheduled):** Page through **active/published** products on the B2C store; for each product load content, variants, inventory, and the EUR contextual price.
2. **Display:** Show products/prices on spacefoot.com.
3. **Ordering:** When restocking, a Spacefoot buyer places an order **by hand** in the B2B portal (§13).

Use the **GraphQL Admin API** only. The REST Admin API is legacy for new work.

Official references:

- [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant)
- [contextualPricing](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariantContextualPricing)
- [Inventory levels and states](https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps/manage-quantities-states)
- [products query](https://shopify.dev/docs/api/admin-graphql/latest/queries/products)

---

## 4. Prerequisites

| Requirement | Notes |
|-------------|--------|
| Shopify **custom app** on `geggamoja` (B2C) | Created by Victory Mantra; Spacefoot receives credentials via secure channel |
| **Admin API access token** | Static token for the custom app |
| **API version** | Pin a stable version, e.g. `2025-10`. Do not use `unstable` in production |

Spacefoot does **not** create or install any app in Shopify Admin — Victory Mantra provisions everything.

---

## 5. Authentication

### 5.1 Endpoint

```http
POST https://geggamoja.myshopify.com/admin/api/2025-10/graphql.json
Content-Type: application/json
X-Shopify-Access-Token: <ADMIN_API_ACCESS_TOKEN>
```

Replace `2025-10` with the agreed API version.

### 5.2 Environment variables (example)

Victory Mantra provides these values when handing off credentials (Spacefoot loads them into vault / `.env` — no Shopify Admin work required):

```bash
SHOPIFY_SHOP_DOMAIN=geggamoja.myshopify.com
SHOPIFY_ADMIN_API_VERSION=2025-10
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_PRICING_COUNTRY=FR
```

**Security**

- Treat `SHOPIFY_ADMIN_ACCESS_TOKEN` as a **secret** (vault, not git).
- Rotate the token on compromise; contact Victory Mantra for re-issue.

### 5.3 Request wrapper (example: Node.js)

```javascript
async function shopifyAdminGraphql({ query, variables }) {
  const url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/${process.env.SHOPIFY_ADMIN_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (json.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}
```

Always inspect `errors` (this guide is query-focused; Spacefoot performs no mutations).

### 5.4 Connectivity / auth check

```graphql
query ShopPing {
  shop {
    name
    myshopifyDomain
    currencyCode
  }
  productsCount(query: "status:active published_status:published") {
    count
  }
}
```

**Example response** (`200 OK`, live B2C store):

```json
{
  "data": {
    "shop": {
      "name": "Geggamoja",
      "myshopifyDomain": "geggamoja.myshopify.com",
      "currencyCode": "SEK"
    },
    "productsCount": { "count": 875 }
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 2,
      "actualQueryCost": 2,
      "throttleStatus": { "maximumAvailable": 20000, "currentlyAvailable": 19998, "restoreRate": 1000 }
    }
  }
}
```

**Example response — invalid or missing token** (`401 Unauthorized`):

```json
{ "errors": "[API] Invalid API key or access token (unrecognized login or wrong password)" }
```

---

## 6. API access scopes (reference — provisioned by Victory Mantra)

> **Spacefoot action required:** **None** for app creation, scope selection, or installation. Victory Mantra creates the custom app on `geggamoja`, enables scopes, and shares the token securely. Spacefoot only **uses** the token.

### Scopes on the Spacefoot B2C app (read-only)

The dedicated app **`geggamoja-b2c-spacefoot`** is provisioned **read-only** (no `write_*` scopes) — verified live against `geggamoja.myshopify.com`:

| Scope | Purpose |
|--------|---------|
| `read_products` | Products, variants, media, metafields, base prices, **contextualPricing (EUR)** |
| `read_inventory` | Inventory items, levels, and quantities |
| `read_metaobjects` | Resolve the **main color** metaobject to a display name (see §7.5) |

No order, customer, company, or write scopes are granted — Spacefoot's integration is strictly read-only.

### What Spacefoot receives from Victory Mantra

| Item | Description |
|------|-------------|
| `SHOPIFY_SHOP_DOMAIN` | `geggamoja.myshopify.com` |
| `SHOPIFY_ADMIN_API_VERSION` | e.g. `2025-10` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin API access token for the B2C custom app |

---

## 7. Core Shopify concepts (relevant to this integration)

### 7.1 Product → Variant → InventoryItem

| Entity | Description |
|--------|-------------|
| `Product` | Parent merchandise record (title, description, type, tags, media) |
| `ProductVariant` | Sellable SKU (options, barcode, price, policy) |
| `InventoryItem` | 1:1 with variant; holds `sku`, `tracked`, and links to stock per **Location** |
| `InventoryLevel` | Quantities of an inventory item at one location (`available`, `on_hand`, `committed`, …) |

### 7.2 Assortment: which products to import

The B2C store has **no** B2B catalog / publication object. The assortment Spacefoot should mirror is the store's **live storefront** — i.e. products that are **active and published**. Filter with the `query` argument on the `products` connection:

```text
status:active published_status:published
```

Live counts (Sep 2026): ~2,092 products total → ~880 active → **~875 active & published**. Import the ~875; skip drafts/archived and unpublished products.

> If Spacefoot should carry only a subset (e.g. a specific collection), Geggamoja can tag those products or place them in a collection and Spacefoot filters by `tag:` or collection membership. Confirm the exact assortment rule with Victory Mantra.

### 7.3 Pricing: SEK base vs EUR for France

The B2C store's **base currency is SEK**. `variant.price` and `variant.compareAtPrice` are **SEK** — do **not** show these to French customers as EUR.

For **EUR**, read the **France market** price via `contextualPricing(context: { country: FR })` on each variant. This returns the exact EUR amount Geggamoja sells for in France, including compare-at:

```graphql
contextualPricing(context: { country: FR }) {
  price { amount currencyCode }
  compareAtPrice { amount currencyCode }
}
```

**Verified live example** (SKU `1024011`):

| Field | SEK (base) | EUR (`country: FR`) |
|-------|-----------|---------------------|
| `price` | `230.30` | **`19.95`** |
| `compareAtPrice` | `329.00` | **`28.95`** |

Use `contextualPricing.price.amount` when `currencyCode` is `EUR`. Treat this as the **recommended retail / consumer selling price** to show on spacefoot.com. `compareAtPrice` is the strike-through (“was”) amount when a product is on sale.

**Wholesale / purchase price (what Spacefoot pays Geggamoja) is not available through this API.** This integration reads only the **B2C** store. Spacefoot does **not** consume the Geggamoja **B2B APIs**, so wholesale amounts cannot be returned in the product feed. Purchase price is visible in the **B2B portal** (`geggamojab2b`) when a buyer places a restock order by hand (§13).

(A public **Storefront API** token with `@inContext(country: FR)` returns the same **consumer** EUR amount — see Appendix B — but the Admin `contextualPricing` path needs no extra token.)

### 7.4 Global IDs (GID)

Shopify GraphQL uses GIDs. Real B2C examples:

```text
gid://shopify/Product/15255708991832
gid://shopify/ProductVariant/55536418980184
gid://shopify/InventoryItem/55151138111832
gid://shopify/Location/103367115096
```

REST numeric IDs map via `legacyResourceId` on many objects.

### 7.5 Product attributes (Spacefoot requirements)

| Attribute | GraphQL source | Notes (live B2C store) |
|-----------|----------------|------------------------|
| **Description** | `product.descriptionHtml` | Rich HTML (Swedish); populated for the vast majority of products |
| **Images (all)** | `product.media` (+ `featuredImage` fallback) | Use `media` for the full gallery, not only `featuredImage` |
| **Material composition** | `product.metafield(namespace: "custom", key: "material")` | Full composition text (Swedish). Fallback: `custom.materials`. May be blank on a minority of products |
| **Material labels (optional)** | `shopify.fabric` and/or `shopify.footwear-material` | Category metafields (same metaobject pattern as Color). Extra structured tags; **not** a substitute for `custom.material` |
| **Main color** | `product.metafield(namespace: "shopify", key: "color-pattern")` | Returns a **metaobject reference**. Resolve to a display name via the metaobject `references` (see below); **fallback:** parse `tags` / title |
| **EAN** | `productVariant.barcode` | Validate: 8–14 digits; reject `kr` / scientific-notation values (§8 Phase D) |
| **EUR RRP / selling price** | `variant.contextualPricing(context: { country: FR })` | France consumer EUR; do not use `variant.price` (SEK) |
| **EUR purchase / wholesale price** | **Not available** | This integration does not call the B2B APIs; wholesale is only in the B2B portal at order time |

> **Language:** B2C content is in **Swedish**. Spacefoot is responsible for translation/localisation to French for display.

**Resolving the main color** — the `color-pattern` metafield points at a metaobject; read its `references` to get the human-readable colour name in one query:

```graphql
colorPattern: metafield(namespace: "shopify", key: "color-pattern") {
  references(first: 3) {
    nodes {
      ... on Metaobject {
        displayName
        field(key: "label") { value }
      }
    }
  }
}
```

Use `field(key: "label").value` (falling back to `displayName`). Verified live: SKU `1024011` → `Rosa`, SKU `HALLA1612` → `Black`. If no reference resolves, fall back to a colour-like `tag` or a word in the title.

**Material composition** — use the custom metafield first. That is the merchant-written composition (percentages, lining, filling), not the short category tags shown in Admin.

```graphql
material: metafield(namespace: "custom", key: "material") { value }
materials: metafield(namespace: "custom", key: "materials") { value }
fabric: metafield(namespace: "shopify", key: "fabric") {
  references(first: 8) {
    nodes {
      ... on Metaobject {
        displayName
        field(key: "label") { value }
      }
    }
  }
}
footwearMaterial: metafield(namespace: "shopify", key: "footwear-material") {
  references(first: 8) {
    nodes {
      ... on Metaobject {
        displayName
        field(key: "label") { value }
      }
    }
  }
}
```

Persist `material.value`, or `materials.value` if `material` is empty. Verified live:

| Product | `custom.material` (composition) | Category labels |
|---------|---------------------------------|-----------------|
| Gummistövlar fodrade Rosa | `EVA - Etenvinylacetat/ Foder 30% Ull/70% Polyester` | Footwear material → `Termoplastisk polyuretan (TPU)` |
| Solglasögon Baby 0-10 m - Rosa | `Flexibel, BPA-fri plast (TPEE) – … REACH.` | Fabric → `Plast` |
| Fothällor till ytterkläder | `100% Silikon` | Fabric → `Gummi`, `Syntetisk` |
| Kokki Mixade färger | `Utsida 100% ekologisk bomullstrikå. Stoppning … polyestervadd.` | (none) |

Admin **Category metafields → Footwear material / Fabric** are taxonomy labels. Some extra chips in Admin can be **suggestions** (not saved). Always treat `custom.material` as the source of truth for composition.

---

## 8. Integration workflow

### Phase A — List the sellable assortment (products + variants + inventory + EUR)

One query returns everything Spacefoot needs per product. Filter to active & published and page with cursors.

```graphql
query SpacefootProducts(
  $first: Int!
  $after: String
  $variantsFirst: Int!
) {
  products(first: $first, after: $after, query: "status:active published_status:published") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      handle
      status
      productType
      vendor
      tags
      updatedAt
      descriptionHtml
      material: metafield(namespace: "custom", key: "material") { value }
      materials: metafield(namespace: "custom", key: "materials") { value }
      colorPattern: metafield(namespace: "shopify", key: "color-pattern") {
        references(first: 3) {
          nodes {
            ... on Metaobject {
              displayName
              field(key: "label") { value }
            }
          }
        }
      }
      fabric: metafield(namespace: "shopify", key: "fabric") {
        references(first: 8) {
          nodes {
            ... on Metaobject {
              displayName
              field(key: "label") { value }
            }
          }
        }
      }
      footwearMaterial: metafield(namespace: "shopify", key: "footwear-material") {
        references(first: 8) {
          nodes {
            ... on Metaobject {
              displayName
              field(key: "label") { value }
            }
          }
        }
      }
      featuredImage { url altText }
      media(first: 15) {
        nodes {
          ... on MediaImage { id image { url altText } }
        }
      }
      variants(first: $variantsFirst) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          sku
          barcode
          availableForSale
          inventoryPolicy
          inventoryQuantity
          price
          compareAtPrice
          selectedOptions { name value }
          contextualPricing(context: { country: FR }) {
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
          }
          inventoryItem {
            id
            tracked
            requiresShipping
            inventoryLevels(first: 5) {
              nodes {
                id
                location { id }
                quantities(names: ["available", "on_hand", "committed", "incoming", "reserved"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
  }
}
```

> Add `location { name }` only if the token has `read_locations`; otherwise the query fails on that field (see §11).

**Variables:**

```json
{ "first": 50, "after": null, "variantsFirst": 100 }
```

**Example response** (one product, verified live — SKU `1024011`):

```json
{
  "data": {
    "products": {
      "pageInfo": { "hasNextPage": true, "endCursor": "eyJsYXN0X2lkIjoxNTI1NTcwODk5MTgzMn0=" },
      "nodes": [
        {
          "id": "gid://shopify/Product/15255708991832",
          "title": "Small Doddi mixade färger Rosa 20 cm",
          "handle": "small-doddi-mixade-farger-rosa-20-cm",
          "status": "ACTIVE",
          "productType": "Babyprodukter",
          "vendor": "Geggamoja",
          "tags": ["Babyprodukter", "Ekologisk bomull", "in-stock", "Litauen", "Multi", "OUTLET"],
          "updatedAt": "2026-09-13T16:04:17Z",
          "descriptionHtml": "<p>Geggamojas återvinningsmaskot i mindre storlek …</p>",
          "material": null,
          "materials": null,
          "colorPattern": { "value": "[\"gid://shopify/Metaobject/365316833624\"]" },
          "featuredImage": {
            "url": "https://cdn.shopify.com/s/files/1/0914/2170/4536/files/102401_248001.jpg?v=1756461036",
            "altText": "Rosa randigt mjukisdjur i ekologisk bomullstrikå …"
          },
          "media": {
            "nodes": [
              { "id": "gid://shopify/MediaImage/1", "image": { "url": "https://cdn.shopify.com/s/files/1/0914/2170/4536/files/102401_248001.jpg?v=1756461036", "altText": null } },
              { "id": "gid://shopify/MediaImage/2", "image": { "url": "https://cdn.shopify.com/s/files/1/0914/2170/4536/files/doddi2_1.jpg?v=1756461036", "altText": null } }
            ]
          },
          "variants": {
            "pageInfo": { "hasNextPage": false, "endCursor": null },
            "nodes": [
              {
                "id": "gid://shopify/ProductVariant/55536418980184",
                "title": "Default Title",
                "sku": "1024011",
                "barcode": "7332833187737",
                "availableForSale": true,
                "inventoryPolicy": "DENY",
                "inventoryQuantity": 220,
                "price": "230.30",
                "compareAtPrice": "329.00",
                "selectedOptions": [{ "name": "Title", "value": "Default Title" }],
                "contextualPricing": {
                  "price": { "amount": "19.95", "currencyCode": "EUR" },
                  "compareAtPrice": { "amount": "28.95", "currencyCode": "EUR" }
                },
                "inventoryItem": {
                  "id": "gid://shopify/InventoryItem/55151138111832",
                  "tracked": true,
                  "requiresShipping": true,
                  "inventoryLevels": {
                    "nodes": [
                      {
                        "id": "gid://shopify/InventoryLevel/…?inventory_item_id=55151138111832",
                        "location": { "id": "gid://shopify/Location/103367115096" },
                        "quantities": [
                          { "name": "available", "quantity": 220 },
                          { "name": "on_hand", "quantity": 225 },
                          { "name": "committed", "quantity": 5 },
                          { "name": "incoming", "quantity": 0 },
                          { "name": "reserved", "quantity": 0 }
                        ]
                      }
                    ]
                  }
                }
              }
            ]
          }
        }
      ]
    }
  }
}
```

**Suggested per-variant output record:**

| Output field | Source |
|--------------|--------|
| `sku` | `variant.sku` |
| `ean` / `ean_status` | `variant.barcode` (validate — Phase D) |
| `title`, `handle`, `product_type`, `vendor`, `tags` | product scalars |
| `description_html` | `product.descriptionHtml` |
| `image_url` / `image_urls` | first / all `media.nodes[].image.url` (fallback `featuredImage.url`) |
| `material` | `custom.material`, else `custom.materials` — full composition text |
| `material_labels` | resolved labels from `shopify.fabric` + `shopify.footwear-material` (optional) |
| `main_color` | resolve `shopify.color-pattern` metaobject, else infer from `tags` / title |
| `price_eur` / `compare_at_eur` | `contextualPricing.price` / `.compareAtPrice` (`FR`) — RRP / selling, **not** wholesale |
| `price_sek` | `variant.price` (reference only) |
| `purchase_price_eur` | **Not available** — Spacefoot does not consume B2B APIs |
| `available_qty` | inventory level `available` at the stock location |
| `inventory_status` | derived enum (§8 Phase C.4) |

**Pagination**

- Products: loop while `pageInfo.hasNextPage`, pass `after: pageInfo.endCursor`.
- If a product has more than `$variantsFirst` variants, paginate `product.variants` with `after` (rare for apparel).

**Example response — empty page:**

```json
{ "data": { "products": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] } } }
```

---

### Phase B — EUR prices (France market)

EUR is already included per variant in Phase A via `contextualPricing(context: { country: FR })`. If Spacefoot prefers a separate price-only lookup (e.g. a public storefront), a Storefront API token with `@inContext(country: FR)` returns the same amount — see Appendix B.

**Rules**

- Show `contextualPricing.price.amount` (EUR) to French customers as the **recommended retail / selling price**.
- Use `compareAtPrice` (EUR) for strike-through / sale display.
- Never present `variant.price` (SEK) as a EUR figure.
- **Wholesale / purchase price is not in this feed.** Spacefoot does not consume B2B APIs, so that amount cannot be returned here.

---

### Phase C — Inventory status

#### C.1 Quick signals (per variant)

| Field | Meaning |
|--------|---------|
| `availableForSale` | Shopify-computed sellability flag |
| `inventoryQuantity` | Total sellable quantity (aggregated; not location-specific) |
| `inventoryPolicy` | `DENY` = do not oversell; `CONTINUE` = allow backorder |
| `inventoryItem.tracked` | `false` → quantities may be meaningless |

#### C.2 Location-level quantities

Quantities come back per location in Phase A (`inventoryItem.inventoryLevels`). To fetch a single item:

```graphql
query VariantInventory($inventoryItemId: ID!) {
  inventoryItem(id: $inventoryItemId) {
    id
    sku
    tracked
    inventoryLevels(first: 5) {
      nodes {
        location { id }
        quantities(names: ["available", "on_hand", "committed"]) { name quantity }
      }
    }
  }
}
```

Victory Mantra will confirm which **location ID** represents stock relevant to Spacefoot. (Location **names** require `read_locations`; without it, match by the location **ID** Victory Mantra provides — e.g. `gid://shopify/Location/103367115096`.)

#### C.3 Inventory states reference

| State | Meaning |
|--------|---------|
| `available` | Units available to sell |
| `on_hand` | Physical stock at location |
| `committed` | Allocated to orders |
| `incoming` | Inbound PO / transfer |
| `reserved` | Held stock |

#### C.4 Suggested normalized status

```text
IN_STOCK        if tracked && available > 0
OUT_OF_STOCK    if tracked && available <= 0 && policy == DENY
BACKORDER       if tracked && available <= 0 && policy == CONTINUE
NOT_TRACKED     if !tracked (surface separately; do not assume zero)
```

> B2C stock reflects consumer sellable quantity. Because Spacefoot buys through the **B2B portal**, treat B2C `available` as a **display/availability signal**, not a guaranteed B2B allocation. Confirm actual purchasable quantity at B2B order time.

---

### Phase D — EAN / barcode validation

Treat `productVariant.barcode` as the EAN/GTIN. Before importing:

```text
valid   → 8–14 digits after stripping non-digits; no "kr" or scientific notation
bad     → contains "kr", "E+", or price-like strings (e.g. "7,332,833,827,503kr", "7,33283E+12")
empty   → null / blank
```

Verified live examples are clean 13-digit EANs (`7332833187737`, `7332833172146`). Flag any `bad`/`empty` rows and send them to Victory Mantra / Geggamoja for correction in Shopify Admin; Spacefoot re-syncs after confirmation.

---

## 9. Large-catalog strategy: Bulk Operations

The assortment (~875 products) is small enough for cursor pagination. If sync approaches GraphQL rate limits, use the [Bulk Operations API](https://shopify.dev/docs/api/usage/bulk-operations/queries):

1. `bulkOperationRunQuery` rooted at `products(query: "status:active published_status:published")`
2. Poll `currentBulkOperation` until `COMPLETED`
3. Download JSONL from `url`

Bulk is asynchronous (minutes) but avoids deep-pagination throttling. Note: `contextualPricing` is generally **not** available in bulk exports — fetch EUR prices in a normal paginated pass and merge by `variant.id`.

---

## 10. Rate limits and reliability

Shopify GraphQL uses a **calculated query cost** bucket. Inspect `extensions.cost` on every response.

```json
{
  "extensions": {
    "cost": {
      "requestedQueryCost": 89,
      "actualQueryCost": 52,
      "throttleStatus": { "maximumAvailable": 20000, "currentlyAvailable": 19948, "restoreRate": 1000 }
    }
  }
}
```

**Practices**

- Request only fields you persist.
- Keep `variants(first:)` and `inventoryLevels(first:)` as low as practical.
- Implement exponential backoff on `429` / `THROTTLED`.

**Example — throttled** (`200` with GraphQL errors):

```json
{
  "errors": [{ "message": "Throttled", "extensions": { "code": "THROTTLED" } }],
  "extensions": { "cost": { "throttleStatus": { "maximumAvailable": 20000, "currentlyAvailable": 0, "restoreRate": 1000 } } }
}
```

**Sync frequency guidance**

| Data | Suggested cadence |
|------|-------------------|
| Full product/content sync | Daily (or on demand) |
| Inventory / price refresh | Every 1–6 hours |

---

## 11. Error handling

| Symptom | Likely cause | Action |
|---------|----------------|--------|
| `401 Unauthorized` | Invalid/revoked token | Rotate token with Victory Mantra |
| `ACCESS_DENIED` on `location { name }` | Missing `read_locations` | Drop `name`, use location `id`; or ask VM to add scope |
| `ACCESS_DENIED` on `markets` / metaobject | Missing `read_markets` / `read_metaobjects` | Not required for core sync; ask VM if colour names / market data needed |
| Empty `products.nodes` | Filter too strict / nothing published | Re-check `status:active published_status:published` |
| Throttled | Query too heavy | Reduce fields or use bulk |
| `inventoryQuantity` null | Not tracked | Use `tracked` + levels |

**Example — missing scope** (`ACCESS_DENIED`, real response from the current token when requesting `location { name }`):

```json
{
  "errors": [
    {
      "message": "Access denied for name field. Required access: `read_locations` access scope or `read_markets_home` access scope.",
      "extensions": { "code": "ACCESS_DENIED", "requiredAccess": "`read_locations` access scope or `read_markets_home` access scope." }
    }
  ]
}
```

Log full `errors[].extensions.code` for support tickets.

---

## 12. Data model mapping (Spacefoot)

```text
Product
  shopify_product_id   (GID + legacyResourceId)
  handle, title, status, product_type, vendor, tags, updated_at
  description_html
  material               (custom.material, else custom.materials — composition text)
  material_labels        (shopify.fabric + shopify.footwear-material labels)
  main_color             (shopify.color-pattern metaobject, or inferred from tags/title)
  image_url              (first image)
  image_urls             (all media, pipe-separated / json)

Variant
  shopify_variant_id
  shopify_inventory_item_id
  sku, barcode, ean_status, options (json)
  available_for_sale, inventory_policy
  price_eur, compare_at_eur      (contextualPricing FR — RRP / selling)
  price_sek                      (reference only)
  purchase_price_eur             (not available — B2B APIs are not in this integration)
  inventory_status               (derived enum)
  available_qty                  (per agreed location)
  location_id                    (location_name only if read_locations granted)
  raw_quantities                 (json: available, on_hand, committed, …)
  last_synced_at
```

**Primary key for commerce:** `sku` (verify uniqueness) + `shopify_variant_id` (stable).

---

## 13. Ordering: manual B2B portal (no API)

Spacefoot does **not** place orders through this API. The purchase flow is:

1. Spacefoot displays Geggamoja products (data from the B2C store) on **spacefoot.com**.
2. A French customer orders from Spacefoot (Spacefoot's own commerce).
3. To fulfil / restock, a Spacefoot buyer logs in to the **Geggamoja B2B portal** (`geggamojab2b`) as their **B2B company account** and **places the wholesale order manually** in the browser.
4. Geggamoja fulfils the B2B order to Spacefoot.

Implications:

- No cart / draft-order / checkout API is in scope.
- B2C `available` quantity is a **display signal**; confirm purchasable stock at B2B order time.
- Match products between the B2C feed and the B2B portal by **SKU** (SKUs are consistent across both stores).
- **Wholesale / purchase price in EUR** is **not** returned by this API. Spacefoot does not consume the B2B APIs; that price is only visible in the B2B portal when ordering by hand.

Contact Victory Mantra / Geggamoja for B2B portal access, wholesale pricing, and MOQ terms.

---

## 14. Testing checklist

1. Run the **§5.4** ping — confirm `Geggamoja`, `SEK`, and a non-zero active/published count (~875).
2. Fetch one page of **§8 Phase A** — confirm content, media, variants, inventory, and EUR `contextualPricing`.
3. Pick a known SKU (e.g. `1024011`) — compare EUR price and stock against the Geggamoja B2C storefront.
4. Validate `barcode` values (Phase D); flag bad/empty EANs for Victory Mantra.
5. Confirm your main-color fallback (tags/title) works where the metaobject can't be resolved.  
6. Confirm material composition: `custom.material` on a clothing/footwear SKU (e.g. Gummistövlar fodrade Rosa) and that empty-material products (e.g. Small Doddi) stay blank.  
7. Load-test pagination across all ~875 products — measure duration and throttle headroom.

---

## 15. Compliance and operational notes

- **GDPR / data minimization:** This API exposes product/inventory data only; no consumer PII.
- **Language:** content is Swedish; Spacefoot localises to French.
- **SLA:** No Shopify API SLA; plan cached reads and graceful degradation.
- **Assortment changes:** products appear/disappear as Geggamoja activates/publishes them on the B2C store.
- **Order flow:** manual B2B (see §13); this document does not describe cart or order APIs.

---

## 16. Support and change management

| Topic | Contact |
|--------|---------|
| Credentials, scopes, token rotation | Victory Mantra — Geggamoja integration team |
| Assortment / which products Spacefoot may carry | Geggamoja + Victory Mantra |
| B2B portal access, wholesale pricing, MOQ | Geggamoja + Victory Mantra |
| Warehouse / location mapping | Geggamoja operations + Victory Mantra |
| API version upgrades | Announced via Victory Mantra; pin version in URL |

**Change log**

| Version | Date | Changes |
|---------|------|---------|
| 1.x | 2026-06 | Earlier draft assuming Spacefoot reads the **B2B** store catalog (superseded) |
| **2.0** | **2026-09-14** | **Rewritten for the correct model: Spacefoot reads the Geggamoja B2C store and orders manually via the B2B portal. Admin API on `geggamoja`, active/published assortment, EUR via `contextualPricing(country: FR)`, real live examples** |
| 2.1 | 2026-09-14 | Named the dedicated read-only app `geggamoja-b2c-spacefoot` and its scopes; added the confirmed colour-metaobject resolution query (§7.5) |
| 2.2 | 2026-09-14 | Material composition: `custom.material` as source of truth, plus optional `shopify.fabric` / `shopify.footwear-material` labels |
| 2.3 | 2026-09-14 | Wholesale / purchase price is **not** available: this integration does not consume B2B APIs |
| 2.4 | 2026-09-14 | Front-matter notice: this document **replaces** the v1.x B2B-catalog guide; product API is B2C-only, not connected to B2B APIs |

---

## Appendix A — cURL example

```bash
curl -s -X POST \
  "https://geggamoja.myshopify.com/admin/api/2025-10/graphql.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: ${SHOPIFY_ADMIN_ACCESS_TOKEN}" \
  -d '{
    "query": "query($f:Int!){ products(first:$f, query:\"status:active published_status:published\"){ nodes { title handle variants(first:1){ nodes { sku barcode price contextualPricing(context:{country:FR}){ price { amount currencyCode } } } } } } }",
    "variables": { "f": 2 }
  }' | jq .
```

---

## Appendix B — Storefront API (optional, price/display)

If Spacefoot uses a public storefront token instead of Admin for price lookups, `@inContext(country: FR)` returns the same EUR amount:

```http
POST https://geggamoja.myshopify.com/api/2025-10/graphql.json
Content-Type: application/json
X-Shopify-Storefront-Access-Token: <STOREFRONT_ACCESS_TOKEN>
```

```graphql
query VariantPrice($handle: String!) @inContext(country: FR) {
  product(handle: $handle) {
    handle
    title
    variants(first: 100) {
      nodes { id sku price { amount currencyCode } }
    }
  }
}
```

Storefront returns only **published** storefront data and no cost/committed inventory internals — use Admin (§8) for the full sync. Request a Storefront token from Victory Mantra only if this path is needed.

---

## Appendix C — Related Shopify documentation

- [products query](https://shopify.dev/docs/api/admin-graphql/latest/queries/products)
- [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant)
- [contextualPricing](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariantContextualPricing)
- [InventoryItem](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem)
- [Bulk operations](https://shopify.dev/docs/api/usage/bulk-operations/queries)

---

*End of document*
