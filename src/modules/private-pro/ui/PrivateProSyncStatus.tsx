import { Button, Chip, LinearProgress, Stack, Typography } from '@mui/joy';

import { humanReadableBytes } from '~/common/util/textUtils';

import { usePrivateProSyncStore } from '../sync/store-private-pro-sync';
import { privateProSyncLabel } from './privatePro.ui';


export function PrivateProSyncStatus() {
  const phase = usePrivateProSyncStore(state => state.phase);
  const pendingOperations = usePrivateProSyncStore(state => state.pendingOperations);
  const lastError = usePrivateProSyncStore(state => state.lastError);
  const usedBytes = usePrivateProSyncStore(state => state.usedBytes);
  const reservedBytes = usePrivateProSyncStore(state => state.reservedBytes);
  const quotaBytes = usePrivateProSyncStore(state => state.quotaBytes);
  const retry = usePrivateProSyncStore(state => state.retry);

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
        {humanReadableBytes(usedBytes)} used, {humanReadableBytes(reservedBytes)} uploading, {humanReadableBytes(quotaBytes)} total
      </Typography>
      {lastError && <Typography level='body-xs' color='danger'>{lastError}</Typography>}
      {(phase === 'offline' || phase === 'error' || phase === 'quota-blocked') && retry && (
        <Button size='sm' variant='soft' onClick={() => void retry()}>Retry sync</Button>
      )}
    </Stack>
  );
}
