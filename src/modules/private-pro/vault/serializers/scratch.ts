import * as z from 'zod/v4';

import {
  scratchClipVaultApply,
  scratchClipVaultReset,
  scratchClipVaultSnapshot,
  scratchClipVaultSubscribe,
} from '~/common/layout/optima/scratchclip/store-scratchclip';

import type { PrivateProVaultLogicalSerializer } from '../privatePro.vault.serializers';


const ScratchSchema = z.object({
  history: z.array(z.object({
    id: z.string().min(1),
    text: z.string(),
    timestamp: z.number(),
    source: z.string().optional(),
  }).strict()).max(10),
}).strict();
type ScratchValue = z.infer<typeof ScratchSchema>;

export const PRIVATE_PRO_VAULT_SCRATCH_ID = 'scratch-clip';

export const privateProVaultScratchSerializer: PrivateProVaultLogicalSerializer<ScratchValue> = {
  recordType: 'scratch',
  schemaVersion: 1,
  schema: ScratchSchema,
  logicalId: () => PRIVATE_PRO_VAULT_SCRATCH_ID,
  snapshot: () => {
    const value = ScratchSchema.parse(scratchClipVaultSnapshot());
    return value.history.length ? [{ logicalId: PRIVATE_PRO_VAULT_SCRATCH_ID, value }] : [];
  },
  apply: (_logicalId, value) => scratchClipVaultApply(value),
  remove: () => scratchClipVaultReset(),
  subscribe: scratchClipVaultSubscribe,
};
