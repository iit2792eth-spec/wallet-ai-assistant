import { isAddress } from "viem";
import { z } from "zod";
import { PROVIDERS } from "./model-types";

const emptyToNull = (value: string) => (value === "" ? null : value);

export const addressSchema = z
  .string()
  .trim()
  .refine((value) => isAddress(value, { strict: false }), "Invalid address");

export const contactSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(64),
    ensName: z
      .string()
      .trim()
      .toLowerCase()
      .max(255)
      .refine((value) => value === "" || /^[^\s.]+(\.[^\s.]+)+$/.test(value), "Invalid ENS name")
      .transform(emptyToNull),
    address: z.union([z.literal(""), addressSchema]).transform(emptyToNull),
  })
  .refine((contact) => contact.ensName !== null || contact.address !== null, "Enter an ENS name or an address");

const httpUrl = z
  .string()
  .trim()
  .refine((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Invalid URL");

export const rpcUrlSchema = httpUrl;

/** Base URL is optional for every provider: empty means the provider's standard endpoint. */
export const modelSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(64),
  provider: z.enum(PROVIDERS),
  modelName: z.string().trim().min(1, "Model name is required").max(128),
  baseUrl: z.union([z.literal(""), httpUrl]).transform(emptyToNull),
  apiKey: z.string().trim().max(512).transform(emptyToNull),
});

/** Editing: an empty API key keeps the saved one, unless clearApiKey is set. */
export const modelUpdateSchema = modelSchema.extend({
  clearApiKey: z.boolean().default(false),
});

/** A positive decimal amount as typed by the user, e.g. "0.05". */
export const amountSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "Invalid amount");

export const limitSchema = z.object({
  perTxMax: amountSchema,
  dailyMax: amountSchema,
  weeklyMax: amountSchema,
  enabled: z.boolean(),
});
