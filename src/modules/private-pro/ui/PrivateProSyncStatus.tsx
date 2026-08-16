import { Chip, LinearProgress, Stack, Typography } from '@mui/joy';

import { humanReadableBytes } from '~/common/util/textUtils';

import { usePrivateProAuth } from '../auth/ProviderPrivatePro';
import { usePrivateProSyncStore } from '../sync/store-private-pro-sync';
import { privateProSyncLabel } from './privatePro.ui';


export function PrivateProSyncStatus() {
  const { bootstrap } = usePrivateProAuth();
  const phase = usePrivateProSyncStore(state => state.phase);
  const pendingOperations = usePrivateProSyncStore(state => state.pendingOperations);
  const lastError = usePrivateProSyncStore(state => state.lastError);
  const usedBytes = bootstrap?.usedBytes ?? 0;
  const quotaBytes = bootstrap?.quotaBytes ?? 1;

  return (
    <Stack spacing={1}>
      <Stack direction='row' justifyContent='space-between' alignItems='center'>
        <Typography level='title-md'>Cloud sync</Typography>
        <Chip size='sm' color={phase === 'error' || phase === 'quota-blocked' ? 'danger' : phase === 'synced' ? 'success' : 'neutral'}>
          {privateProSyncLabel(phase)}
        </Chip>
      </Stack>
      <Typography level='body-sm' textColor='text.secondary'>
        {pendingOperations ? `${pendingOperations} change${pendingOperations === 1 ? '' : 's'} waiting` : 'Chats, personas, and attachments'}
      </Typography>
      <LinearProgress determinate value={Math.min(100, 100 * usedBytes / quotaBytes)} />
      <Typography level='body-xs' textColor='text.secondary'>
        {humanReadableBytes(usedBytes)} of {humanReadableBytes(quotaBytes)} attachment storage
      </Typography>
      {lastError && <Typography level='body-xs' color='danger'>{lastError}</Typography>}
    </Stack>
  );
}
