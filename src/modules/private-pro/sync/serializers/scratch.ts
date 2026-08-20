import * as z from 'zod/v4';

import {
  scratchClipSyncApply,
  scratchClipSyncReset,
  scratchClipSyncSnapshot,
  scratchClipSyncSubscribe,
} from '~/common/layout/optima/scratchclip/store-scratchclip';

import type { PrivateProSyncLogicalSerializer } from '../privatePro.sync.serializers';


const ScratchSchema = z.object({
  history: z.array(z.object({
    id: z.string().min(1),
    text: z.string(),
    timestamp: z.number(),
    source: z.string().optional(),
  }).strict()).max(10),
}).strict();
type ScratchValue = z.infer<typeof ScratchSchema>;

export const PRIVATE_PRO_SYNC_SCRATCH_ID = 'scratch-clip';

export const privateProSyncScratchSerializer: PrivateProSyncLogicalSerializer<ScratchValue> = {
  recordType: 'scratch',
  schemaVersion: 1,
  schema: ScratchSchema,
  logicalId: () => PRIVATE_PRO_SYNC_SCRATCH_ID,
  projectionKey: () => PRIVATE_PRO_SYNC_SCRATCH_ID,
  snapshot: () => {
    const value = ScratchSchema.parse(scratchClipSyncSnapshot());
    return value.history.length ? [{ logicalId: PRIVATE_PRO_SYNC_SCRATCH_ID, value }] : [];
  },
  apply: (_logicalId, value) => scratchClipSyncApply(value),
  remove: () => scratchClipSyncReset(),
  subscribe: scratchClipSyncSubscribe,
};
