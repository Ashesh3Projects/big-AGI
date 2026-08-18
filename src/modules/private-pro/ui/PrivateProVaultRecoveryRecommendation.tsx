import * as React from 'react';
import { Alert, Button, Stack } from '@mui/joy';


export function PrivateProVaultRecoveryRecommendation(props: {
  busy: boolean;
  onRevoke(): Promise<void>;
}) {
  return <Alert color='warning' variant='soft' role='alert' sx={{ m: 1 }}>
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
      <span>Vault credentials changed. Revoke other remembered devices if recovery was security-sensitive.</span>
      <Button size='sm' color='warning' loading={props.busy} onClick={() => void props.onRevoke()}>
        Revoke other devices now
      </Button>
    </Stack>
  </Alert>;
}
