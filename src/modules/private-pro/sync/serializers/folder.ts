import * as z from 'zod/v4';

import { folderVaultApply, folderVaultRemove, folderVaultSnapshot, folderVaultSubscribe } from '~/common/stores/folders/store-chat-folders';

import type { PrivateProSyncLogicalSerializer } from '../privatePro.sync.serializers';


const FolderSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  conversationIds: z.array(z.string().min(1)),
  color: z.string().optional(),
}).strict();
type FolderValue = z.infer<typeof FolderSchema>;

export const privateProSyncFolderSerializer: PrivateProSyncLogicalSerializer<FolderValue> = {
  recordType: 'folder',
  schemaVersion: 1,
  schema: FolderSchema,
  logicalId: value => value.id,
  projectionKey: value => value.id,
  snapshot: () => folderVaultSnapshot().map(folder => ({ logicalId: folder.id, value: FolderSchema.parse(folder) })),
  apply: (_logicalId, value) => folderVaultApply(value),
  remove: folderVaultRemove,
  subscribe: folderVaultSubscribe,
};
