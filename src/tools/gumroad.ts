import { z } from "zod";
import { Env, ToolDefinition } from "../types";

const GUMROAD_API_BASE = "https://api.gumroad.com/v2";

async function callGumroad(
  endpoint: string,
  options: {
    method?: string;
    body?: any;
    token?: string;
  },
  env: Env
): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  const token = options.token?.trim() || env.GUMROAD_ACCESS_TOKEN?.trim() || "";
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "Missing Gumroad Access Token. Configure GUMROAD_ACCESS_TOKEN or pass 'token' parameter.",
    };
  }

  const cleanPath = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  const url = `${GUMROAD_API_BASE}/${cleanPath}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "Lokha-MCP-Gateway/1.0",
  };

  const reqOptions: RequestInit = {
    method: options.method || "GET",
    headers,
  };

  if (options.body && ["POST", "PUT", "PATCH"].includes((options.method || "POST").toUpperCase())) {
    const formParams = new URLSearchParams();
    for (const [key, value] of Object.entries(options.body)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          value.forEach((v) => formParams.append(`${key}[]`, String(v)));
        } else {
          formParams.append(key, String(value));
        }
      }
    }
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    reqOptions.body = formParams.toString();
  }

  try {
    const res = await fetch(url, reqOptions);
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data.message || `Gumroad API error HTTP ${res.status}`,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (err: any) {
    return {
      ok: false,
      status: 500,
      error: err.message || "Failed to communicate with Gumroad API",
    };
  }
}

export const gumroadTools: ToolDefinition[] = [
  {
    name: "gumroad_list_products",
    description:
      "Query all digital products, prices, sales counts, and store URLs configured on Gumroad.",
    scope: "public",
    tier: "free",
    schema: {
      token: z.string().optional().describe("Optional Gumroad Personal Access Token (uses environment if omitted)"),
    },
    handler: async (args: { token?: string }, env: Env) => {
      const res = await callGumroad("products", { method: "GET", token: args.token }, env);
      if (!res.ok) return { ok: false, error: res.error, status: res.status };

      const products = (res.data?.products || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        price: p.price ? p.price / 100 : 0,
        currency: p.currency || "usd",
        url: p.short_url || p.url,
        customPermalink: p.custom_permalink,
        salesCount: p.sales_count || 0,
        salesUsd: p.sales_usd_cents ? (p.sales_usd_cents / 100).toFixed(2) : "0.00",
        published: p.published !== false,
      }));

      return {
        ok: true,
        count: products.length,
        products,
      };
    },
  },
  {
    name: "gumroad_create_product",
    description:
      "Programmatically create a new digital product, guide, or service on Gumroad with custom pricing and permalinks.",
    scope: "public",
    tier: "free",
    schema: {
      name: z.string().describe("Title of the product"),
      priceCents: z.number().describe("Base price in cents (e.g. 1400 = $14.00)"),
      description: z.string().describe("HTML or markdown description of the product"),
      customPermalink: z.string().optional().describe("Custom URL slug on Gumroad (e.g. 'pranic-kitchen')"),
      suggestedPriceCents: z.number().optional().describe("Suggested price in cents if pay-what-you-want is enabled"),
      customizablePrice: z.boolean().optional().default(true).describe("Allow customers to pay what they want"),
      tags: z.array(z.string()).optional().describe("Array of discovery tags"),
      url: z.string().url().optional().describe("Digital file download URL or redirect link"),
      token: z.string().optional().describe("Optional Gumroad Access Token"),
    },
    handler: async (args: any, env: Env) => {
      const body: Record<string, any> = {
        name: args.name,
        price: args.priceCents,
        description: args.description,
        customizable_price: args.customizablePrice !== false ? "true" : "false",
      };

      if (args.customPermalink) body.custom_permalink = args.customPermalink;
      if (args.suggestedPriceCents) body.suggested_price_cents = args.suggestedPriceCents;
      if (args.tags) body.tags = args.tags;
      if (args.url) body.url = args.url;

      const res = await callGumroad("products", { method: "POST", body, token: args.token }, env);
      if (!res.ok) return { ok: false, error: res.error, status: res.status };

      return {
        ok: true,
        product: res.data?.product,
        url: res.data?.product?.short_url || res.data?.product?.url,
        id: res.data?.product?.id,
      };
    },
  },
  {
    name: "gumroad_get_sales_metrics",
    description:
      "Fetch real-time gross revenue, orders, and sales breakdown across all Gumroad digital products.",
    scope: "public",
    tier: "free",
    schema: {
      token: z.string().optional().describe("Optional Gumroad Personal Access Token"),
      page: z.number().optional().default(1).describe("Page number for sales pagination"),
    },
    handler: async (args: { token?: string; page?: number }, env: Env) => {
      const res = await callGumroad(`sales?page=${args.page || 1}`, { method: "GET", token: args.token }, env);
      if (!res.ok) return { ok: false, error: res.error, status: res.status };

      const sales = res.data?.sales || [];
      let totalGrossCents = 0;
      const productSalesMap: Record<string, { units: number; grossUsd: string }> = {};

      for (const s of sales) {
        const cents = s.price || 0;
        totalGrossCents += cents;
        const name = s.product_name || "Unknown Product";
        if (!productSalesMap[name]) {
          productSalesMap[name] = { units: 0, grossUsd: "0.00" };
        }
        productSalesMap[name].units += 1;
        const currentGross = parseFloat(productSalesMap[name].grossUsd);
        productSalesMap[name].grossUsd = (currentGross + cents / 100).toFixed(2);
      }

      return {
        ok: true,
        totalGrossUsd: (totalGrossCents / 100).toFixed(2),
        totalOrders: sales.length,
        byProduct: productSalesMap,
        recentOrders: sales.slice(0, 5).map((s: any) => ({
          orderId: s.order_number || s.id,
          productName: s.product_name,
          priceUsd: ((s.price || 0) / 100).toFixed(2),
          email: s.email ? `${s.email.slice(0, 3)}***@${s.email.split("@")[1] || "gumroad.com"}` : "anonymous",
          createdAt: s.created_at,
        })),
      };
    },
  },
];
