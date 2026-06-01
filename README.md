# Geggamoja B2B Catalog API — Integration Guide for Spacefoot

**Document version:** 1.0  
**Last updated:** 2026-06-01  
**Audience:** Spacefoot Team   
**Author:** Victory Mantra (Shopify Developer for Geggamoja)  
**Status:** Draft for handoff — credentials and catalog membership are provisioned by Victory Mantra / Geggamoja

---

## 1. Purpose and scope

This document describes how **Spacefoot** can programmatically read **products**, **variants**, and **inventory status** from Geggamoja’s **Shopify B2B** store, limited to the **Spacefoot / France (EUR) catalog**.

### In scope

- Authentication and environment configuration for the Shopify **Admin GraphQL API**
- Resolving the dedicated B2B catalog and its **publication** (product visibility) and **price list** (EUR pricing)
- Listing catalog products and variants (SKU, barcode, options, identifiers)
- Reading inventory quantities and sellability signals
- Pagination, rate limits, error handling, and recommended sync patterns
- Optional webhooks for incremental inventory/product updates

### Out of scope

- **Order placement**, fulfillment, payments, or returns (Spacefoot uses the B2B storefront / company account separately)
- Write access to products, prices, or inventory (read-only integration unless explicitly agreed otherwise)
- Geggamoja B2C storefront or non–Spacefoot catalogs

---

## 2. Business context

| Party | Role |
|--------|------|
| **Geggamoja** | Brand; products are sold via Shopify B2B and B2C |
| **Victory Mantra** | Builds and operates Shopify stores / integrations for Geggamoja |
| **Spacefoot** | Distribution partner ([spacefoot.com](https://spacefoot.com/)); expands Geggamoja into France. Holds a **B2B company account** on the Geggamoja B2B store and fulfills customer demand from the agreed catalog |
| **Catalog** | **Spacefoot / France — EUR catalog** — curated subset of variants Spacefoot may sell |

**Store (B2B):** `geggamojab2b`([geggamojab2b.com](https://geggamojab2b.com/))  
**Admin catalog (reference):** [Euro catalog in Shopify Admin](https://admin.shopify.com/store/geggamojab2b/catalogs/88934580363)  
**Numeric catalog ID:** `88934580363`  
**GraphQL catalog GID (initial):** `gid://shopify/Catalog/88934580363`  
*(After the first `catalog` query, use the concrete `__typename` and `id` returned — e.g. `MarketCatalog` with `gid://shopify/MarketCatalog/88934580363`.)*

**Resolved IDs (from live API verification):**

| Resource | GID |
|----------|-----|
| Catalog | `gid://shopify/MarketCatalog/88934580363` |
| Publication | `gid://shopify/Publication/186172997771` |
| Price list (EUR) | `gid://shopify/PriceList/26895024267` |
| Primary stock location (sample) | `gid://shopify/Location/80575266955` |

Product assortment for Spacefoot is **managed in this catalog** by Geggamoja. API consumers should treat **catalog publication membership** as the source of truth for “which SKUs Spacefoot may offer,” not the full shop product list.

---

## 3. Architecture overview

```text
┌─────────────────────┐         HTTPS POST           ┌──────────────────────────────┐
│  Spacefoot          │  ───────────────────────►    │  Shopify Admin GraphQL API   │
│  integration        │   /admin/api/{version}/      │  store: geggamojab2b         │
│  service            │        graphql.json          │                              │
└─────────────────────┘                              │  ┌────────────────────────┐  │
        ▲                                            │  │ Catalog (EUR / France) │  │
        │                                            │  │  ├─ Publication        │  │
        │  credentials (custom app)                  │  │  └─ PriceList (EUR)    │  │
        │                                            │  └────────────────────────┘  │
┌───────┴─────────────┐                              └──────────────────────────────┘
│ Victory Mantra      │
│ provisions app +    │
│ env / token         │
└─────────────────────┘
```

**Recommended data flow**

1. **Bootstrap:** Resolve catalog → `publication.id` + `priceList.id`.
2. **Catalog sync (scheduled):** Page through products in the catalog publication; for each product, load variants + inventory + EUR prices.
3. **Incremental (optional):** Subscribe to webhooks (`inventory_levels/update`, `products/update`) and patch local cache.

Use **GraphQL Admin API** only. The REST Admin API is legacy for new work; product/catalog/inventory features are richest and best supported on GraphQL.

Official references:

- [Catalog query](https://shopify.dev/docs/api/admin-graphql/latest/queries/catalog)
- [Publication object](https://shopify.dev/docs/api/admin-graphql/latest/objects/Publication)
- [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant)
- [Inventory levels and states](https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps/manage-quantities-states)
- [B2B catalogs](https://shopify.dev/docs/apps/build/b2b/manage-catalogs)

---

## 4. Prerequisites

| Requirement | Notes |
|-------------|--------|
| Shopify **custom app** on `geggamojab2b` | Created by Victory Mantra; Spacefoot receives credentials via secure channel |
| **Admin API access token** | Static token for custom app, or OAuth if a public app is used (not expected here) |
| **API version** | Pin a stable version, e.g. `2025-10`. Do not use `unstable` in production |



---

## 5. Authentication

### 5.1 Endpoint

```http
POST https://geggamojab2b.myshopify.com/admin/api/2025-10/graphql.json
Content-Type: application/json
X-Shopify-Access-Token: <ADMIN_API_ACCESS_TOKEN>
```

Replace `2025-10` with the agreed API version.

### 5.2 Environment variables (example)
Victory Mantra provides these values when handing off credentials (Spacefoot loads them into vault / .env — no Shopify Admin work required):

```bash
SHOPIFY_SHOP_DOMAIN=geggamojab2b.myshopify.com
SHOPIFY_ADMIN_API_VERSION=2025-10
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_CATALOG_ID=88934580363
SHOPIFY_CATALOG_GID=gid://shopify/Catalog/88934580363
SHOPIFY_PUBLICATION_GID=gid://shopify/Publication/186172997771
SHOPIFY_PRICE_LIST_GID=gid://shopify/PriceList/26895024267
```

**Security**

- Treat `SHOPIFY_ADMIN_ACCESS_TOKEN` as a **secret** (vault, not git).
- The token is already scoped by Victory Mantra (see §6 for reference).
- Rotate token on compromise; contact Victory Mantra for re-issue.

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

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}
```

Always inspect `errors` and mutation `userErrors` (this guide is query-focused).

### 5.4 Example response — connectivity / auth check

Use a minimal `shop` query to confirm the token and store before running catalog queries:

```graphql
query ShopPing {
  shop {
    name
    myshopifyDomain
  }
}
```

**Example response** (`200 OK`, `geggamojab2b`, API version `2025-10`):

```json
{
  "data": {
    "shop": {
      "name": "GEGGAMOJA B2B",
      "myshopifyDomain": "geggamojab2b.myshopify.com"
    }
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 1,
      "actualQueryCost": 1,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 19999,
        "restoreRate": 1000
      }
    }
  }
}
```

**Example response — invalid or missing token** (`401 Unauthorized`):

```json
{
  "errors": "[API] Invalid API key or access token (unrecognized login or wrong password)"
}
```

---

## 6. API access scopes (reference — provisioned by Victory Mantra)

> **Spacefoot action required:** **None** for app creation, scope selection, or installation in Shopify Admin.  
> Victory Mantra has **already created** the custom app on `geggamojab2b`, enabled the scopes below, and will **share the Admin API credentials** (access token, shop domain, API version, catalog GIDs) securely. Spacefoot only **uses** the token in API requests.

This section documents what the issued token is allowed to do, useful for debugging `ACCESS_DENIED` errors. If a query fails for missing scope, contact **Victory Mantra** 

### Scopes enabled on the shared app (read-only)

| Scope | Purpose |
|--------|---------|
| `read_products` | Products, variants, media, base prices |
| `read_inventory` | Inventory items, levels, quantities by location |
| `read_publications` | Publication membership for catalog assortment |
| `read_markets` (and related catalog access) | Catalog and EUR price list visibility |

May also be included on the token (no extra setup needed on Spacefoot’s side):

| Scope | Purpose |
|--------|---------|
| `read_locations` | Fulfillment location names in inventory responses |


### What Spacefoot receives from Victory Mantra

| Item | Description |
|------|-------------|
| `SHOPIFY_SHOP_DOMAIN` | e.g. `geggamojab2b.myshopify.com` |
| `SHOPIFY_ADMIN_API_VERSION` | e.g. `2025-10` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin API access token for the custom app |
| Catalog / publication / price list GIDs | See §2 |

Optional later (if incremental sync is needed): webhook endpoint URL registration may be done by Victory Mantra or documented separately; Spacefoot can provide the HTTPS receiver.

---

## 7. Core Shopify concepts (relevant to this integration)

### 7.1 Catalog

A **catalog** is a merchant-defined assortment with optional:

- **Publication** — which products/variants are visible in that catalog context  
- **Price list** — contextual prices (here: **EUR**)

Your integration targets catalog ID **`88934580363`**.

### 7.2 Publication vs entire store

Only products **published to the catalog’s publication** should be imported. Querying `products(first: 250)` without a publication filter will return the **entire shop** and violate assortment boundaries.

### 7.3 Product → Variant → InventoryItem

| Entity | Description |
|--------|-------------|
| `Product` | Parent merchandise record (title, description, type, tags) |
| `ProductVariant` | Sellable SKU (options, barcode, weight, policy) |
| `InventoryItem` | 1:1 with variant; holds `sku`, `tracked`, and links to stock per **Location** |
| `InventoryLevel` | Quantities of an inventory item at one location (`available`, `on_hand`, `committed`, etc.) |

### 7.4 Pricing for Spacefoot (EUR)

Catalog-linked **price lists** override variant base prices. For France/EUR, read prices from the catalog’s `priceList` (currency `EUR`), not only `variant.price` (often shop default currency).

### 7.5 Global IDs (GID)

Shopify GraphQL uses GIDs:

```text
gid://shopify/Catalog/88934580363          → resolves as MarketCatalog
gid://shopify/MarketCatalog/88934580363
gid://shopify/Publication/186172997771
gid://shopify/PriceList/26895024267
gid://shopify/Product/8023878434955
gid://shopify/ProductVariant/45013613838475
gid://shopify/InventoryItem/47104611975307
gid://shopify/Location/80575266955
```

REST numeric IDs map via `legacyResourceId` on many objects.

---

## 8. Integration workflow

### Phase A — Bootstrap catalog metadata

```graphql
query SpacefootCatalogBootstrap($catalogId: ID!) {
  catalog(id: $catalogId) {
    id
  }
}
```

**Note:** The Admin API returns a concrete catalog type (`CompanyLocationCatalog`, `MarketCatalog`, etc.). Use the returned `id` as canonical. For Geggamoja’s Euro catalog, the live type is **`MarketCatalog`**.

**Example response — minimal bootstrap:**

```json
{
  "data": {
    "catalog": {
      "id": "gid://shopify/MarketCatalog/88934580363"
    }
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 1,
      "actualQueryCost": 1,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 19999,
        "restoreRate": 1000
      }
    }
  }
}
```

Extended bootstrap:

```graphql
query SpacefootCatalogBootstrap($catalogId: ID!) {
  catalog(id: $catalogId) {
    id
    title
    status
    priceList {
      id
      name
      currency
    }
    publication {
      id
      autoPublish
    }
  }
}
```

**Variables:**

```json
{
  "catalogId": "gid://shopify/Catalog/88934580363"
}
```

**Example response — extended bootstrap:**

```json
{
  "data": {
    "catalog": {
      "id": "gid://shopify/MarketCatalog/88934580363",
      "title": "Euro Catalog",
      "status": "ACTIVE",
      "priceList": {
        "id": "gid://shopify/PriceList/26895024267",
        "name": "Euro Catalog - 620c07c6-d78d-4d0c-82de-7c08143a828e",
        "currency": "EUR"
      },
      "publication": {
        "id": "gid://shopify/Publication/186172997771",
        "autoPublish": true
      }
    }
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 3,
      "actualQueryCost": 3,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 19997,
        "restoreRate": 1000
      }
    }
  }
}
```

Persist:

- `publication.id` → drives product listing  
- `priceList.id` + `priceList.currency` → should be `EUR`  
- `catalog.status` → expect `ACTIVE`

If `publication` is `null`, contact Victory Mantra — assortment rules may fall back to channel defaults ([catalog behavior](https://shopify.dev/docs/apps/build/markets/new-markets/catalogs)).

**Example response — catalog not found** (wrong GID):

```json
{
  "data": {
    "catalog": null
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 3,
      "actualQueryCost": 1,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 19999,
        "restoreRate": 1000
      }
    }
  }
}
```

---

### Phase B — List products in the Spacefoot (EUR) catalog

Use the publication’s product connection. Prefer **`includedProducts`** (and filter in your pipeline) or the publication’s product listing fields available on your pinned API version.

```graphql
query SpacefootCatalogProducts(
  $publicationId: ID!
  $productsFirst: Int!
  $productsAfter: String
  $variantsFirst: Int!
) {
  publication(id: $publicationId) {
    id
    includedProducts(first: $productsFirst, after: $productsAfter) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        status
        productType
        vendor
        tags
        updatedAt
        featuredImage {
          url
          altText
        }
        variants(first: $variantsFirst) {
          pageInfo {
            hasNextPage
          }
          nodes {
            id
            title
            sku
            barcode
            position
            availableForSale
            inventoryPolicy
            inventoryQuantity
            price
            compareAtPrice
            selectedOptions {
              name
              value
            }
            inventoryItem {
              id
              tracked
              requiresShipping
              inventoryLevels(first: 20) {
                nodes {
                  id
                  location {
                    id
                    name
                  }
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
}
```

**Variables:**

```json
{
  "publicationId": "gid://shopify/Publication/186172997771",
  "productsFirst": 50,
  "productsAfter": null,
  "variantsFirst": 100
}
```

**Example response** (truncated to two products; inventory and variant fields as returned by the API):

```json
{
  "data": {
    "publication": {
      "id": "gid://shopify/Publication/186172997771",
      "includedProducts": {
        "pageInfo": {
          "hasNextPage": true,
          "endCursor": "eyJsYXN0X2lkIjo4MDIzODc4NDAyMTg3LCJsYXN0X3ZhbHVlIjoiODAyMzg3ODQwMjE4NyJ9"
        },
        "nodes": [
          {
            "id": "gid://shopify/Product/8023878402187",
            "title": "Skallra Grå/Vit",
            "handle": "skallra-gra-vit",
            "status": "DRAFT",
            "productType": "Baby & Toddler Toys",
            "vendor": "Geggamoja",
            "tags": [],
            "updatedAt": "2025-05-12T10:22:15Z",
            "featuredImage": {
              "url": "https://cdn.shopify.com/s/files/1/0xxx/files/skallra.jpg",
              "altText": null
            },
            "variants": {
              "pageInfo": { "hasNextPage": false },
              "nodes": [
                {
                  "id": "gid://shopify/ProductVariant/45013613772939",
                  "title": "Default Title",
                  "sku": "375761",
                  "barcode": null,
                  "position": 1,
                  "availableForSale": false,
                  "inventoryPolicy": "DENY",
                  "inventoryQuantity": 0,
                  "price": "199.00",
                  "compareAtPrice": null,
                  "selectedOptions": [
                    { "name": "Title", "value": "Default Title" }
                  ],
                  "inventoryItem": {
                    "id": "gid://shopify/InventoryItem/47104611975306",
                    "tracked": true,
                    "requiresShipping": true,
                    "inventoryLevels": {
                      "nodes": [
                        {
                          "id": "gid://shopify/InventoryLevel/114997461130?inventory_item_id=47104611975306",
                          "location": {
                            "id": "gid://shopify/Location/80575266955",
                            "name": "Bryggare Bergs Väg 2"
                          },
                          "quantities": [
                            { "name": "available", "quantity": 0 },
                            { "name": "on_hand", "quantity": 0 },
                            { "name": "committed", "quantity": 0 },
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
          },
          {
            "id": "gid://shopify/Product/8023878434955",
            "title": "Small Doddi mixade färger Rosa 20 cm",
            "handle": "small-doddi-mixade-farger-rosa-20-cm",
            "status": "ACTIVE",
            "productType": "Baby & Toddler Toys",
            "vendor": "Geggamoja",
            "tags": ["bestseller"],
            "updatedAt": "2025-06-01T08:15:42Z",
            "featuredImage": {
              "url": "https://cdn.shopify.com/s/files/1/0xxx/files/doddi-rosa.jpg",
              "altText": "Small Doddi pink"
            },
            "variants": {
              "pageInfo": { "hasNextPage": false },
              "nodes": [
                {
                  "id": "gid://shopify/ProductVariant/45013613838475",
                  "title": "Default Title",
                  "sku": "1024011",
                  "barcode": "7350012345678",
                  "position": 1,
                  "availableForSale": true,
                  "inventoryPolicy": "DENY",
                  "inventoryQuantity": 278,
                  "price": "24.90",
                  "compareAtPrice": "29.90",
                  "selectedOptions": [
                    { "name": "Title", "value": "Default Title" }
                  ],
                  "inventoryItem": {
                    "id": "gid://shopify/InventoryItem/47104611975307",
                    "tracked": true,
                    "requiresShipping": true,
                    "inventoryLevels": {
                      "nodes": [
                        {
                          "id": "gid://shopify/InventoryLevel/114997461131?inventory_item_id=47104611975307",
                          "location": {
                            "id": "gid://shopify/Location/80575266955",
                            "name": "Bryggare Bergs Väg 2"
                          },
                          "quantities": [
                            { "name": "available", "quantity": 278 },
                            { "name": "on_hand", "quantity": 278 },
                            { "name": "committed", "quantity": 0 },
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
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 89,
      "actualQueryCost": 52,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 19948,
        "restoreRate": 1000
      }
    }
  }
}
```

> **Note:** `featuredImage.url`, `tags`, `productType`, and some scalar fields in the sample above are illustrative where omitted from the verification query; structure and IDs match the live store. Re-run `node verify-shopify-catalog.mjs` for current values.

**Pagination**

- Products: loop while `pageInfo.hasNextPage`, pass `after: pageInfo.endCursor`.
- If a product has more than `$variantsFirst` variants, paginate `product.variants` with `after` (rare for apparel SKUs).

**Example response — empty catalog publication:**

```json
{
  "data": {
    "publication": {
      "id": "gid://shopify/Publication/186172997771",
      "includedProducts": {
        "pageInfo": {
          "hasNextPage": false,
          "endCursor": null
        },
        "nodes": []
      }
    }
  }
}
```

**Alternative filter (shop-wide products query):**

```graphql
products(first: 50, query: "publication_ids:<PUBLICATION_NUMERIC_ID>") { ... }
```

Use only if publication traversal is insufficient on your API version. Prefer publication-rooted queries for clarity.

---

### Phase C — EUR prices from the catalog price list

After bootstrap, page `priceList.prices`:

```graphql
query SpacefootCatalogPrices(
  $priceListId: ID!
  $first: Int!
  $after: String
) {
  priceList(id: $priceListId) {
    id
    currency
    prices(first: $first, after: $after, originType: FIXED) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        originType
        price {
          amount
          currencyCode
        }
        compareAtPrice {
          amount
          currencyCode
        }
        variant {
          id
          sku
          product {
            id
            handle
          }
        }
      }
    }
  }
}
```

**Variables:**

```json
{
  "priceListId": "gid://shopify/PriceList/26895024267",
  "first": 50,
  "after": null
}
```

**Example response — fixed prices on price list** (current catalog has no fixed EUR rows yet):

```json
{
  "data": {
    "priceList": {
      "id": "gid://shopify/PriceList/26895024267",
      "currency": "EUR",
      "prices": {
        "pageInfo": {
          "hasNextPage": false,
          "endCursor": null
        },
        "nodes": []
      }
    }
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 7,
      "actualQueryCost": 5,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 19995,
        "restoreRate": 1000
      }
    }
  }
}
```

**Example response — fixed price present** (structure when Geggamoja adds fixed EUR prices):

```json
{
  "data": {
    "priceList": {
      "id": "gid://shopify/PriceList/26895024267",
      "currency": "EUR",
      "prices": {
        "pageInfo": {
          "hasNextPage": false,
          "endCursor": null
        },
        "nodes": [
          {
            "originType": "FIXED",
            "price": {
              "amount": "24.90",
              "currencyCode": "EUR"
            },
            "compareAtPrice": {
              "amount": "29.90",
              "currencyCode": "EUR"
            },
            "variant": {
              "id": "gid://shopify/ProductVariant/45013613838475",
              "sku": "1024011",
              "product": {
                "id": "gid://shopify/Product/8023878434955",
                "handle": "small-doddi-mixade-farger-rosa-20-cm"
              }
            }
          }
        ]
      }
    }
  }
}
```

Merge prices into your variant map by `variant.id`.

**Relative / percentage-based prices:** If no fixed price exists, Shopify computes price from the price list’s `parent.adjustment`. For full accuracy, also fetch:

```graphql
priceList(id: $priceListId) {
  parent {
    adjustment { type value }
  }
}
```

and apply the same rules as B2B checkout, or call `productVariant.contextualPricing` with the appropriate B2B context (advanced; coordinate with Victory Mantra if you rely on contextual rules).

**Example response — price list parent adjustment** (live Euro catalog):

```json
{
  "data": {
    "priceList": {
      "id": "gid://shopify/PriceList/26895024267",
      "currency": "EUR",
      "parent": {
        "adjustment": {
          "type": "PERCENTAGE_DECREASE",
          "value": 0
        }
      }
    }
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 3,
      "actualQueryCost": 3,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 19997,
        "restoreRate": 1000
      }
    }
  }
}
```

When `fixedPricesCount` is `0` and adjustment `value` is `0`, variant **base** prices apply (converted to EUR per market rules). Confirm pricing with Victory Mantra before go-live.

---

### Phase D — Inventory status (detailed)

#### D.1 Quick signals (per variant)

| Field | Meaning |
|--------|---------|
| `availableForSale` | Shopify-computed sellability flag |
| `inventoryQuantity` | Total sellable quantity (aggregated); convenient but **not location-specific** |
| `inventoryPolicy` | `DENY` = do not oversell; `CONTINUE` = allow backorder |
| `inventoryItem.tracked` | `false` → quantities may be meaningless |

#### D.2 Location-level quantities (recommended for fulfillment)

Query `inventoryItem.inventoryLevels` as in Phase B, or fetch a single level:

```graphql
query VariantInventoryAtLocation($inventoryItemId: ID!, $locationId: ID!) {
  inventoryItem(id: $inventoryItemId) {
    id
    sku
    tracked
    inventoryLevel(locationId: $locationId) {
      id
      quantities(names: ["available", "on_hand", "committed"]) {
        name
        quantity
      }
      location {
        id
        name
      }
    }
  }
}
```

Victory Mantra will confirm which **location ID(s)** represent stock available to Spacefoot (e.g. EU warehouse vs global).

**Variables:**

```json
{
  "inventoryItemId": "gid://shopify/InventoryItem/47104611975307",
  "locationId": "gid://shopify/Location/80575266955"
}
```

**Example response — inventory at a single location** (SKU `1024011`, in stock):

```json
{
  "data": {
    "inventoryItem": {
      "id": "gid://shopify/InventoryItem/47104611975307",
      "sku": "1024011",
      "tracked": true,
      "inventoryLevel": {
        "id": "gid://shopify/InventoryLevel/114997461131?inventory_item_id=47104611975307",
        "quantities": [
          { "name": "available", "quantity": 278 },
          { "name": "on_hand", "quantity": 278 },
          { "name": "committed", "quantity": 0 }
        ],
        "location": {
          "id": "gid://shopify/Location/80575266955",
          "name": "Bryggare Bergs Väg 2"
        }
      }
    }
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 4,
      "actualQueryCost": 4,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 19996,
        "restoreRate": 1000
      }
    }
  }
}
```

**Example response — out of stock at location** (SKU `375761`):

```json
{
  "data": {
    "inventoryItem": {
      "id": "gid://shopify/InventoryItem/47104611975306",
      "sku": "375761",
      "tracked": true,
      "inventoryLevel": {
        "id": "gid://shopify/InventoryLevel/114997461130?inventory_item_id=47104611975306",
        "quantities": [
          { "name": "available", "quantity": 0 },
          { "name": "on_hand", "quantity": 0 },
          { "name": "committed", "quantity": 0 }
        ],
        "location": {
          "id": "gid://shopify/Location/80575266955",
          "name": "Bryggare Bergs Väg 2"
        }
      }
    }
  }
}
```

#### D.3 Inventory states reference

| State | Typical use |
|--------|-------------|
| `available` | Units available to sell |
| `on_hand` | Physical stock at location |
| `committed` | Allocated to orders |
| `incoming` | Inbound PO / transfer |
| `reserved` | Held stock |

See [Manage inventory quantities and states](https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps/manage-quantities-states).

#### D.4 Suggested normalized status for Spacefoot systems

Derive a simple enum in **your** OMS/PIM:

```text
IN_STOCK        if tracked && available > 0
OUT_OF_STOCK    if tracked && available <= 0 && policy == DENY
BACKORDER       if tracked && available <= 0 && policy == CONTINUE
NOT_TRACKED     if !tracked (surface separately; do not assume zero stock)
```

---

## 9. Composite query (single sync pass)

For smaller catalogs, combine bootstrap + first page in one request. For large catalogs, split to avoid cost limits.

```graphql
query SpacefootCatalogSyncPage(
  $catalogId: ID!
  $productsFirst: Int!
  $productsAfter: String
) {
  catalog(id: $catalogId) {
    id
    title
    status
    priceList {
      id
      currency
    }
    publication {
      id
      includedProducts(first: $productsFirst, after: $productsAfter) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          handle
          status
          updatedAt
          variants(first: 100) {
            nodes {
              id
              sku
              barcode
              availableForSale
              inventoryPolicy
              inventoryQuantity
              selectedOptions { name value }
              inventoryItem {
                id
                tracked
                inventoryLevels(first: 10) {
                  nodes {
                    location { id name }
                    quantities(names: ["available", "on_hand", "committed"]) {
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
  }
}
```

**Variables:**

```json
{
  "catalogId": "gid://shopify/Catalog/88934580363",
  "productsFirst": 50,
  "productsAfter": null
}
```

**Example response** (first page; combine with Phase C for prices):

```json
{
  "data": {
    "catalog": {
      "id": "gid://shopify/MarketCatalog/88934580363",
      "title": "Euro Catalog",
      "status": "ACTIVE",
      "priceList": {
        "id": "gid://shopify/PriceList/26895024267",
        "currency": "EUR"
      },
      "publication": {
        "id": "gid://shopify/Publication/186172997771",
        "includedProducts": {
          "pageInfo": {
            "hasNextPage": true,
            "endCursor": "eyJsYXN0X2lkIjo4MDIzODc4NDAyMTg3LCJsYXN0X3ZhbHVlIjoiODAyMzg3ODQwMjE4NyJ9"
          },
          "nodes": [
            {
              "id": "gid://shopify/Product/8023878402187",
              "title": "Skallra Grå/Vit",
              "handle": "skallra-gra-vit",
              "status": "DRAFT",
              "updatedAt": "2025-05-12T10:22:15Z",
              "variants": {
                "nodes": [
                  {
                    "id": "gid://shopify/ProductVariant/45013613772939",
                    "sku": "375761",
                    "barcode": null,
                    "availableForSale": false,
                    "inventoryPolicy": "DENY",
                    "inventoryQuantity": 0,
                    "selectedOptions": [
                      { "name": "Title", "value": "Default Title" }
                    ],
                    "inventoryItem": {
                      "id": "gid://shopify/InventoryItem/47104611975306",
                      "tracked": true,
                      "inventoryLevels": {
                        "nodes": [
                          {
                            "location": {
                              "id": "gid://shopify/Location/80575266955",
                              "name": "Bryggare Bergs Väg 2"
                            },
                            "quantities": [
                              { "name": "available", "quantity": 0 },
                              { "name": "on_hand", "quantity": 0 },
                              { "name": "committed", "quantity": 0 }
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
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 15,
      "actualQueryCost": 12,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 19988,
        "restoreRate": 1000
      }
    }
  }
}
```

Run a second pass for `priceList.prices` pagination and merge by `variant.id`.

---

## 10. Large-catalog strategy: Bulk Operations

If the assortment exceeds ~1,000 variants or sync approaches GraphQL **rate limits**, use the [Bulk Operations API](https://shopify.dev/docs/api/usage/bulk-operations/queries):

1. `bulkOperationRunQuery` with a query rooted at `publication` or `products` filter  
2. Poll `currentBulkOperation` until `COMPLETED`  
3. Download JSONL from `url`  
4. Join inventory and price list in a second bulk job if needed  

Bulk is **asynchronous** (minutes) but avoids deep pagination throttling. Victory Mantra can provide a bulk query template tuned to your catalog size.

---

## 11. Incremental updates (webhooks)

Webhook reference: [Shopify webhooks](https://shopify.dev/docs/apps/build/webhooks).

**Example payload — `inventory_levels/update`** (structure; numeric IDs vary):

```json
{
  "inventory_item_id": 47104611975307,
  "location_id": 80575266955,
  "available": 275,
  "updated_at": "2026-06-01T14:32:10+02:00"
}
```

**Example payload — `products/update`** (partial):

```json
{
  "admin_graphql_api_id": "gid://shopify/Product/8023878434955",
  "id": 8023878434955,
  "title": "Small Doddi mixade färger Rosa 20 cm",
  "handle": "small-doddi-mixade-farger-rosa-20-cm",
  "status": "active",
  "updated_at": "2026-06-01T14:30:00+02:00"
}
```

After a webhook, re-query the variant or `inventoryItem` to align with catalog publication and location-level quantities.

---

## 12. Rate limits and reliability

### 12.1 GraphQL cost limits

Shopify GraphQL uses a **calculated query cost** bucket (typically 1000 points, restore rate 50/sec on standard plans; Plus may differ).  

**Practices:**

- Request only fields you persist  
- Keep `variants(first:)` and `inventoryLevels(first:)` as low as practical  
- Use bulk operations for full exports  
- Implement exponential backoff on `429` / `THROTTLED`  

Inspect the `extensions.cost` object on every response. **Example from `geggamojab2b` (Plus-scale bucket):**

```json
{
  "extensions": {
    "cost": {
      "requestedQueryCost": 13,
      "actualQueryCost": 10,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 19990,
        "restoreRate": 1000
      }
    }
  }
}
```

**Example response — throttled** (`200` with GraphQL errors):

```json
{
  "errors": [
    {
      "message": "Throttled",
      "extensions": {
        "code": "THROTTLED"
      }
    }
  ],
  "extensions": {
    "cost": {
      "requestedQueryCost": 1002,
      "actualQueryCost": null,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 0,
        "restoreRate": 1000
      }
    }
  }
}
```

Retry with exponential backoff when `currentlyAvailable` is low or `THROTTLED` is returned.

### 12.2 Sync frequency guidance

| Catalog size | Suggested full sync | Incremental |
|--------------|---------------------|---------------|
| &lt; 500 variants | Every 1–6 hours | Webhooks |
| 500–5,000 | Every 6–24 hours | Webhooks + hourly reconciliation |
| &gt; 5,000 | Daily bulk + webhooks | Required |

Inventory during high order volume may lag seconds to minutes; design checkout/ATP rules accordingly.

### 12.3 Idempotency and cursor storage

Store `endCursor` per resource type. On failure, retry the same cursor. Use `updatedAt` on products for auxiliary change detection.

---

## 13. Error handling

| Symptom | Likely cause | Action |
|---------|----------------|--------|
| `401 Unauthorized` | Invalid/revoked token | Rotate token with Victory Mantra |
| `403` / access denied | Missing scope | Contact Victory Mantra to adjust app scopes (Spacefoot cannot change scopes) |
| `catalog` is `null` | Wrong GID or ID | Verify `88934580363`; use bootstrap query |
| Empty `includedProducts` | Nothing published to catalog | Merchant action — contact Victory Mantra |
| `read_publications` error | Scope missing | Add `read_publications` |
| Throttled | Query too heavy | Reduce fields or use bulk |
| `inventoryQuantity` null | Not tracked | Use `tracked` + levels |

Log full `errors[].extensions.code` for support tickets.

**Example response — missing scope** (`403` / GraphQL access denied):

```json
{
  "errors": [
    {
      "message": "Access denied for publication field. Required access: `read_publications` access scope.",
      "locations": [{ "line": 2, "column": 3 }],
      "extensions": {
        "code": "ACCESS_DENIED",
        "documentation": "https://shopify.dev/api/usage/access-scopes",
        "requiredAccess": "`read_publications` access scope."
      }
    }
  ],
  "data": {
    "publication": null
  }
}
```

**Example response — GraphQL validation error** (malformed query):

```json
{
  "errors": [
    {
      "message": "Field 'invalidField' doesn't exist on type 'Product'",
      "locations": [{ "line": 5, "column": 5 }],
      "extensions": {
        "code": "undefinedField",
        "typeName": "Product",
        "fieldName": "invalidField"
      }
    }
  ]
}
```

---

## 14. Data model mapping (Spacefoot)

Suggested minimum schema:

```text
Product
  shopify_product_id   (GID + legacyResourceId)
  handle, title, status, product_type, tags, image_url, updated_at

Variant
  shopify_variant_id
  shopify_inventory_item_id
  sku, barcode, options (json), available_for_sale, inventory_policy
  eur_price, eur_compare_at_price   (from price list)
  inventory_status                  (derived enum)
  available_qty                     (per agreed location)
  location_id, location_name
  raw_quantities                    (json: available, on_hand, committed, …)
  last_synced_at
```

**Primary key for commerce:** `sku` (verify uniqueness) + `shopify_variant_id` (stable).

---

## 15. Testing checklist

1. Call bootstrap query — confirm `ACTIVE`, EUR `priceList`, non-null `publication`.  
2. Fetch one known SKU — compare Admin UI variant page.  
3. Change stock in Admin (test product) — confirm `available` updates after webhook or sync.  
4. Delist product from catalog — confirm it disappears on next sync.  
5. Load test pagination on full catalog — measure duration and throttle headroom.

---

## 16. Compliance and operational notes

- **GDPR / data minimization:** This API exposes product/inventory data only; no consumer PII.  
- **SLA:** No Shopify API SLA; plan cached reads and graceful degradation.  
- **Assortment changes:** New SKUs appear only after Victory Mantra / Geggamoja adds them to the Spacefoot EUR catalog.  
- **Order flow:** Spacefoot B2B account checkout is separate; this document does not describe cart or draft order APIs.

---

## 17. Support and change management

| Topic | Contact |
|--------|---------|
| Credentials, scopes, catalog membership | Victory Mantra — Geggamoja integration team |
| Warehouse / location mapping for ATP | Geggamoja operations + Victory Mantra |
| API version upgrades | Announced via Victory Mantra; pin version in URL |

**Change log**

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-06-01 | Initial Spacefoot catalog + inventory read guide |
| 1.1 | 2026-06-01 | Added live example responses from `geggamojab2b` verification |
| 1.2 | 2026-06-01 | Clarified Victory Mantra provisions app/scopes/creds; no Shopify Admin setup for Spacefoot |

---

## Appendix A — cURL example

```bash
curl -s -X POST \
  "https://geggamojab2b.myshopify.com/admin/api/2025-10/graphql.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: ${SHOPIFY_ADMIN_ACCESS_TOKEN}" \
  -d '{
    "query": "query($id: ID!) { catalog(id: $id) { id title status priceList { id currency } publication { id } } }",
    "variables": { "id": "gid://shopify/Catalog/88934580363" }
  }' | jq .
```

**Example response** (same as §8 Phase A extended bootstrap):

```json
{
  "data": {
    "catalog": {
      "id": "gid://shopify/MarketCatalog/88934580363",
      "title": "Euro Catalog",
      "status": "ACTIVE",
      "priceList": {
        "id": "gid://shopify/PriceList/26895024267",
        "currency": "EUR"
      },
      "publication": {
        "id": "gid://shopify/Publication/186172997771"
      }
    }
  },
  "extensions": {
    "cost": {
      "requestedQueryCost": 3,
      "actualQueryCost": 3,
      "throttleStatus": {
        "maximumAvailable": 20000,
        "currentlyAvailable": 19997,
        "restoreRate": 1000
      }
    }
  }
}
```

---

## Appendix B — REST (legacy, not recommended)

REST endpoints such as `GET /admin/api/{version}/products.json` do not understand B2B catalog publication context cleanly. **Do not use REST** for this integration unless GraphQL is blocked — if so, escalate to Victory Mantra.

---

## Appendix C — Related Shopify documentation

- [Catalog query](https://shopify.dev/docs/api/admin-graphql/latest/queries/catalog)  
- [Catalogs overview](https://shopify.dev/docs/apps/build/markets/new-markets/catalogs)  
- [Manage B2B catalogs](https://shopify.dev/docs/apps/build/b2b/manage-catalogs)  
- [PriceList](https://shopify.dev/docs/api/admin-graphql/latest/objects/PriceList)  
- [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant)  
- [InventoryItem](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem)  
- [inventoryLevel query](https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryLevel)  

---

*End of document*
