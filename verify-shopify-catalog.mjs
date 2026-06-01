#!/usr/bin/env node
/**
 * Verifies Geggamoja B2B Spacefoot catalog API access per SPACEFOOT_SHOPIFY_CATALOG_API.md
 * Usage: node verify-shopify-catalog.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv(filePath) {
  const env = {};
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function maskToken(token) {
  if (!token || token.length < 12) return "(missing or too short)";
  return `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`;
}

async function shopifyGraphql(env, query, variables = {}) {
  const domain = env.SHOPIFY_SHOP_DOMAIN?.replace(/^https?:\/\//, "");
  const version = env.SHOPIFY_ADMIN_API_VERSION || "2025-10";
  const url = `https://${domain}/admin/api/${version}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

const CHECKS = [];

function record(name, passed, detail = "") {
  CHECKS.push({ name, passed, detail });
  const icon = passed ? "✓" : "✗";
  console.log(`${icon} ${name}${detail ? `: ${detail}` : ""}`);
}

const BOOTSTRAP_QUERY = `
  query SpacefootCatalogBootstrap($catalogId: ID!) {
    catalog(id: $catalogId) {
      __typename
      id
      title
      status
      priceList {
        id
        name
        currency
        fixedPricesCount
      }
      publication {
        id
        autoPublish
      }
    }
  }
`;

const PRODUCTS_SAMPLE_QUERY = `
  query SpacefootCatalogProductsSample($publicationId: ID!) {
    publication(id: $publicationId) {
      id
      includedProducts(first: 3) {
        pageInfo {
          hasNextPage
        }
        nodes {
          id
          title
          handle
          status
          variants(first: 5) {
            nodes {
              id
              sku
              barcode
              availableForSale
              inventoryPolicy
              inventoryQuantity
              inventoryItem {
                id
                tracked
                inventoryLevels(first: 3) {
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
`;

const PRICES_SAMPLE_QUERY = `
  query SpacefootPriceListSample($priceListId: ID!) {
    priceList(id: $priceListId) {
      id
      currency
      prices(first: 5, originType: FIXED) {
        pageInfo { hasNextPage }
        nodes {
          price { amount currencyCode }
          variant { id sku }
        }
      }
    }
  }
`;

const SHOP_QUERY = `
  query ShopPing {
    shop {
      name
      myshopifyDomain
    }
  }
`;

async function main() {
  const envPath = join(__dirname, ".env");
  let env;
  try {
    env = loadEnv(envPath);
  } catch (e) {
    console.error(`Failed to read .env: ${e.message}`);
    process.exit(1);
  }

  console.log("Geggamoja B2B — Spacefoot catalog API verification\n");
  console.log(`Shop:     ${env.SHOPIFY_SHOP_DOMAIN || "(missing)"}`);
  console.log(`API ver:  ${env.SHOPIFY_ADMIN_API_VERSION || "(missing)"}`);
  console.log(`Catalog:  ${env.SHOPIFY_CATALOG_GID || env.SHOPIFY_CATALOG_ID || "(missing)"}`);
  console.log(`Token:    ${maskToken(env.SHOPIFY_ADMIN_ACCESS_TOKEN)}\n`);

  if (!env.SHOPIFY_SHOP_DOMAIN || !env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
    record("Environment variables", false, "SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN required");
    process.exit(1);
  }

  const catalogGid =
    env.SHOPIFY_CATALOG_GID ||
    `gid://shopify/Catalog/${env.SHOPIFY_CATALOG_ID}`;

  // 1. Auth / shop ping
  const ping = await shopifyGraphql(env, SHOP_QUERY);
  if (!ping.ok) {
    record("HTTP connectivity", false, `status ${ping.status}`);
  } else if (ping.json.errors?.length) {
    record(
      "Authentication (shop query)",
      false,
      ping.json.errors.map((e) => e.message).join("; "),
    );
  } else if (ping.json.data?.shop) {
    record(
      "Authentication (shop query)",
      true,
      `${ping.json.data.shop.name} (${ping.json.data.shop.myshopifyDomain})`,
    );
  } else {
    record("Authentication (shop query)", false, "empty shop response");
  }

  if (!CHECKS.at(-1)?.passed) {
    printSummary();
    process.exit(1);
  }

  // 2. Catalog bootstrap
  const bootstrap = await shopifyGraphql(env, BOOTSTRAP_QUERY, {
    catalogId: catalogGid,
  });

  if (bootstrap.json.errors?.length) {
    record(
      "Catalog bootstrap query",
      false,
      bootstrap.json.errors.map((e) => e.message).join("; "),
    );
    printSummary();
    process.exit(1);
  }

  const catalog = bootstrap.json.data?.catalog;
  if (!catalog) {
    record("Catalog bootstrap query", false, `catalog null for ${catalogGid}`);
    printSummary();
    process.exit(1);
  }

  record(
    "Catalog bootstrap query",
    true,
    `${catalog.__typename} — "${catalog.title}" (${catalog.status})`,
  );

  record(
    "Catalog status ACTIVE",
    catalog.status === "ACTIVE",
    catalog.status,
  );

  const publicationId = catalog.publication?.id;
  record(
    "Catalog has publication",
    Boolean(publicationId),
    publicationId || "missing — assortment may be undefined",
  );

  const priceList = catalog.priceList;
  record(
    "Catalog has price list",
    Boolean(priceList?.id),
    priceList
      ? `${priceList.name || "price list"} — ${priceList.currency} (${priceList.fixedPricesCount ?? "?"} fixed prices)`
      : "missing",
  );

  if (priceList?.currency) {
    record(
      "Price list currency is EUR",
      priceList.currency === "EUR",
      priceList.currency,
    );
  }

  // 3. Sample products from publication
  if (publicationId) {
    const productsRes = await shopifyGraphql(env, PRODUCTS_SAMPLE_QUERY, {
      publicationId,
    });

    if (productsRes.json.errors?.length) {
      record(
        "Publication products + variants + inventory",
        false,
        productsRes.json.errors.map((e) => e.message).join("; "),
      );
    } else {
      const nodes =
        productsRes.json.data?.publication?.includedProducts?.nodes ?? [];
      const variantCount = nodes.reduce(
        (n, p) => n + (p.variants?.nodes?.length ?? 0),
        0,
      );
      const withInventory = nodes.flatMap((p) =>
        (p.variants?.nodes ?? []).filter((v) => v.inventoryItem?.id),
      );

      record(
        "Publication products + variants + inventory",
        nodes.length > 0,
        `${nodes.length} product(s), ${variantCount} variant(s) in sample (first 3 products)`,
      );

      if (nodes.length === 0) {
        record(
          "Catalog has published products",
          false,
          "includedProducts empty — add products to catalog in Admin",
        );
      } else {
        const sample = nodes[0];
        const v0 = sample.variants?.nodes?.[0];
        console.log(
          `    Sample product: "${sample.title}" (${sample.handle}) — status ${sample.status}`,
        );
        if (v0) {
          const levels = v0.inventoryItem?.inventoryLevels?.nodes ?? [];
          console.log(
            `    Sample variant: sku=${v0.sku ?? "(none)"} availableForSale=${v0.availableForSale} inventoryQuantity=${v0.inventoryQuantity} tracked=${v0.inventoryItem?.tracked}`,
          );
          for (const lvl of levels.slice(0, 2)) {
            const q = Object.fromEntries(
              (lvl.quantities ?? []).map((x) => [x.name, x.quantity]),
            );
            console.log(
              `      @ ${lvl.location?.name}: available=${q.available ?? "n/a"} on_hand=${q.on_hand ?? "n/a"}`,
            );
          }
        }
        record(
          "Variants expose inventoryItem",
          withInventory.length > 0,
          `${withInventory.length}/${variantCount} variants in sample`,
        );
      }
    }
  }

  // 4. Sample EUR prices
  if (priceList?.id) {
    const pricesRes = await shopifyGraphql(env, PRICES_SAMPLE_QUERY, {
      priceListId: priceList.id,
    });

    if (pricesRes.json.errors?.length) {
      record(
        "Price list fixed prices",
        false,
        pricesRes.json.errors.map((e) => e.message).join("; "),
      );
    } else {
      const priceNodes =
        pricesRes.json.data?.priceList?.prices?.nodes ?? [];
      record(
        "Price list fixed prices",
        true,
        `${priceNodes.length} price(s) in sample (first 5)`,
      );
      if (priceNodes[0]) {
        const p = priceNodes[0];
        console.log(
          `    Sample price: ${p.price?.amount} ${p.price?.currencyCode} — variant sku=${p.variant?.sku ?? "n/a"}`,
        );
      }
    }
  }

  // Throttle info from last successful response
  const ext = bootstrap.json.extensions?.cost?.throttleStatus;
  if (ext) {
    console.log(
      `\nAPI throttle: ${ext.currentlyAvailable}/${ext.maximumAvailable} available (restore ${ext.restoreRate}/s)`,
    );
  }

  if (catalog.publication?.id || catalog.priceList?.id) {
    console.log("\nDiscovered IDs (for .env):");
    if (catalog.publication?.id) {
      console.log(`  SHOPIFY_PUBLICATION_GID=${catalog.publication.id}`);
    }
    if (catalog.priceList?.id) {
      console.log(`  SHOPIFY_PRICE_LIST_GID=${catalog.priceList.id}`);
    }
    if (catalog.publication?.id || catalog.priceList?.id) {
      tryUpdateEnv(envPath, {
        SHOPIFY_PUBLICATION_GID: catalog.publication?.id,
        SHOPIFY_PRICE_LIST_GID: catalog.priceList?.id,
      });
    }
  }

  printSummary();

  const failed = CHECKS.filter((c) => !c.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

function tryUpdateEnv(filePath, updates) {
  let content = readFileSync(filePath, "utf8");
  let changed = false;
  for (const [key, value] of Object.entries(updates)) {
    if (!value) continue;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (!re.test(content)) continue;
    const line = content.match(re)?.[0] ?? "";
    if (line === `${key}=` || line === `${key}=""` || line === `${key}=''`) {
      content = content.replace(re, `${key}=${value}`);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(filePath, content);
    console.log("  (updated empty values in .env)");
  }
}

function printSummary() {
  const passed = CHECKS.filter((c) => c.passed).length;
  const failed = CHECKS.filter((c) => !c.passed).length;
  console.log(`\n--- Summary: ${passed} passed, ${failed} failed ---`);
  if (publicationIdFromChecks()) {
    console.log("\nTip: persist these in .env after successful bootstrap:");
    console.log("  SHOPIFY_PUBLICATION_GID=...");
    console.log("  SHOPIFY_PRICE_LIST_GID=...");
  }
}

function publicationIdFromChecks() {
  return CHECKS.some((c) => c.name === "Catalog has publication" && c.passed);
}

main().catch((err) => {
  console.error("\nUnexpected error:", err.message);
  process.exit(1);
});
