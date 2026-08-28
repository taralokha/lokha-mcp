import { z } from "zod";
import { Env, ToolDefinition } from "../types";

export const r2Tools: ToolDefinition[] = [
  {
    name: "r2_list_files",
    description: "List files and objects in your private Cloudflare R2 storage bucket (Platform Owner Tool).",
    scope: "private",
    tier: "free",
    requiredRole: "owner",
    schema: {
      prefix: z.string().optional().describe("Prefix path to filter objects (e.g. 'documents/' or 'backups/')"),
      limit: z.number().optional().default(50).describe("Maximum number of files to return (default: 50)"),
      cursor: z.string().optional().describe("Pagination cursor token"),
    },
    handler: async ({ prefix, limit, cursor }: { prefix?: string; limit?: number; cursor?: string }, env: Env) => {
      if (!env.R2_STORAGE) {
        return {
          error: "R2_STORAGE binding is not available in the current environment.",
        };
      }

      const listing = await env.R2_STORAGE.list({
        prefix,
        limit: Math.min(limit || 50, 500),
        cursor,
      });

      return {
        objects: listing.objects.map((obj) => ({
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded.toISOString(),
          httpMetadata: obj.httpMetadata,
          customMetadata: obj.customMetadata,
        })),
        truncated: listing.truncated,
        cursor: listing.truncated ? (listing as any).cursor : undefined,
      };
    },
  },
  {
    name: "r2_read_file",
    description: "Read the text content of a file from your private Cloudflare R2 storage bucket (Platform Owner Tool).",
    scope: "private",
    tier: "free",
    requiredRole: "owner",
    schema: {
      key: z.string().describe("The file path / key in the R2 bucket"),
    },
    handler: async ({ key }: { key: string }, env: Env) => {
      if (!env.R2_STORAGE) {
        return { error: "R2_STORAGE binding is not available." };
      }

      const object = await env.R2_STORAGE.get(key);
      if (!object) {
        return { error: `File not found: ${key}` };
      }

      const text = await object.text();
      return {
        key: object.key,
        size: object.size,
        contentType: object.httpMetadata?.contentType || "text/plain",
        content: text,
      };
    },
  },
  {
    name: "r2_write_file",
    description: "Write or upload text/JSON data to a file in your private Cloudflare R2 storage bucket (Platform Owner Tool).",
    scope: "private",
    tier: "free",
    requiredRole: "owner",
    schema: {
      key: z.string().describe("The target file path / key in the R2 bucket"),
      content: z.string().describe("The file content to write (text, JSON, markdown, etc.)"),
      contentType: z.string().optional().default("text/plain").describe("MIME type (e.g. text/plain, application/json, text/markdown)"),
    },
    handler: async ({ key, content, contentType }: { key: string; content: string; contentType?: string }, env: Env) => {
      if (!env.R2_STORAGE) {
        return { error: "R2_STORAGE binding is not available." };
      }

      const object = await env.R2_STORAGE.put(key, content, {
        httpMetadata: { contentType: contentType || "text/plain" },
      });

      return {
        success: true,
        key: object.key,
        size: object.size,
        uploaded: object.uploaded.toISOString(),
      };
    },
  },
  {
    name: "r2_delete_file",
    description: "Delete a file from your private Cloudflare R2 storage bucket (Platform Owner Tool).",
    scope: "private",
    tier: "free",
    requiredRole: "owner",
    schema: {
      key: z.string().describe("The file path / key to delete"),
    },
    handler: async ({ key }: { key: string }, env: Env) => {
      if (!env.R2_STORAGE) {
        return { error: "R2_STORAGE binding is not available." };
      }

      await env.R2_STORAGE.delete(key);
      return {
        success: true,
        message: `File '${key}' deleted successfully from R2 storage.`,
      };
    },
  },
];
