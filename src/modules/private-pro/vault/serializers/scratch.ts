import type { PrivateProVaultLogicalSerializer } from '../privatePro.vault.serializers';
import { privateProSyncScratchSerializer } from '../../sync/serializers/scratch';


export const privateProVaultScratchSerializer = privateProSyncScratchSerializer as unknown as PrivateProVaultLogicalSerializer<unknown>;
