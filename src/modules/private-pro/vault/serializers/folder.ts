import type { PrivateProVaultLogicalSerializer } from '../privatePro.vault.serializers';
import { privateProSyncFolderSerializer } from '../../sync/serializers/folder';


export const privateProVaultFolderSerializer = privateProSyncFolderSerializer as unknown as PrivateProVaultLogicalSerializer<unknown>;
