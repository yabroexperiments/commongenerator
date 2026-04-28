/**
 * Supabase DB helpers for the `generations` table.
 *
 * The schema is shipped as `sql/0001_generations.sql`. Each app applies
 * it to its own Supabase project. Engine functions accept a
 * SupabaseClient (created server-side with the service-role key) so
 * the engine itself never reads env vars for DB access — credentials
 * stay 100% per-app.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GenerationRow, ProviderName } from "./types";

const TABLE = "generations";

export async function insertGeneration(
  sb: SupabaseClient,
  row: {
    id: string;
    kind?: string;
    original_image_url: string;
    prompt: string;
    provider: ProviderName;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await sb.from(TABLE).insert({
    id: row.id,
    kind: row.kind ?? null,
    original_image_url: row.original_image_url,
    prompt: row.prompt,
    provider: row.provider,
    metadata: row.metadata ?? null,
    status: "processing",
  });
  if (error) {
    throw new Error(`generations insert failed: ${error.message}`);
  }
}

export async function setProviderTaskId(
  sb: SupabaseClient,
  id: string,
  providerTaskId: string,
): Promise<void> {
  const { error } = await sb
    .from(TABLE)
    .update({ provider_task_id: providerTaskId })
    .eq("id", id);
  if (error) {
    throw new Error(`generations update task_id failed: ${error.message}`);
  }
}

export async function setCompleted(
  sb: SupabaseClient,
  id: string,
  resultImageUrl: string,
): Promise<void> {
  const { error } = await sb
    .from(TABLE)
    .update({ status: "completed", result_image_url: resultImageUrl })
    .eq("id", id);
  if (error) {
    throw new Error(`generations setCompleted failed: ${error.message}`);
  }
}

export async function setFailed(
  sb: SupabaseClient,
  id: string,
  errorMessage: string,
): Promise<void> {
  const { error } = await sb
    .from(TABLE)
    .update({ status: "failed", error_message: errorMessage })
    .eq("id", id);
  if (error) {
    throw new Error(`generations setFailed failed: ${error.message}`);
  }
}

export async function getGeneration(
  sb: SupabaseClient,
  id: string,
): Promise<GenerationRow | null> {
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .single<GenerationRow>();
  if (error || !data) return null;
  return data;
}
