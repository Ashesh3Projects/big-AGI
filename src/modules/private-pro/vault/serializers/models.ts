import type { PrivateProVaultLogicalSerializer } from '../privatePro.vault.serializers';
import {
  privateProSyncCredentialSerializer,
  privateProSyncModelSerializer,
  type CredentialServiceValue,
  type ModelServiceValue,
} from '../../sync/serializers/models';


export const privateProVaultCredentialSerializer = privateProSyncCredentialSerializer as unknown as PrivateProVaultLogicalSerializer<CredentialServiceValue>;
export const privateProVaultModelSerializer = privateProSyncModelSerializer as unknown as PrivateProVaultLogicalSerializer<ModelServiceValue>;
