import type { PrivateProVaultLogicalSerializer } from '../privatePro.vault.serializers';
import { privateProSyncPersonaSerializer } from '../../sync/serializers/persona';
import type { SyncPersona } from '../../sync/privatePro.sync.schemas';


export const privateProVaultPersonaSerializer = privateProSyncPersonaSerializer as unknown as PrivateProVaultLogicalSerializer<SyncPersona>;
