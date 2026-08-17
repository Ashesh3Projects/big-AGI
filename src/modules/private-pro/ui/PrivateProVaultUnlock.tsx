import * as React from 'react';
import { Alert, Button, FormControl, FormLabel, Input, Sheet, Stack, Tab, TabList, TabPanel, Tabs, Typography } from '@mui/joy';

import { privateProVaultPasswordStrength } from '../vault/ProviderPrivateProVault';


export interface PrivateProVaultUnlockProps {
  busy: boolean;
  error: string | null;
  onPassword(password: string): Promise<void>;
  onRecovery(recoveryKey: string, newPassword: string): Promise<void>;
  onLogout(): Promise<void>;
}

export function PrivateProVaultUnlock(props: PrivateProVaultUnlockProps) {
  const [password, setPassword] = React.useState('');
  const [recoveryKey, setRecoveryKey] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [newPasswordConfirmation, setNewPasswordConfirmation] = React.useState('');
  const strength = privateProVaultPasswordStrength(newPassword);

  return (
    <Sheet sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Stack spacing={2} sx={{ width: 'min(100%, 520px)' }}>
        <Typography level='h2'>Unlock your private vault</Typography>
        <Tabs defaultValue={0}>
          <TabList>
            <Tab>Vault password</Tab>
            <Tab>Recovery key</Tab>
          </TabList>
          <TabPanel value={0} sx={{ px: 0 }}>
            <Stack spacing={1.5}>
              <FormControl>
                <FormLabel>Vault password</FormLabel>
                <Input type='password' autoComplete='current-password' value={password} onChange={event => setPassword(event.target.value)} />
              </FormControl>
              <Button loading={props.busy} disabled={!password} onClick={() => void props.onPassword(password)}>Unlock</Button>
            </Stack>
          </TabPanel>
          <TabPanel value={1} sx={{ px: 0 }}>
            <Stack spacing={1.5}>
              <FormControl>
                <FormLabel>Recovery key</FormLabel>
                <Input autoComplete='off' value={recoveryKey} onChange={event => setRecoveryKey(event.target.value)} />
              </FormControl>
              <FormControl>
                <FormLabel>New vault password</FormLabel>
                <Input type='password' autoComplete='new-password' value={newPassword} onChange={event => setNewPassword(event.target.value)} />
              </FormControl>
              <FormControl>
                <FormLabel>Confirm new password</FormLabel>
                <Input type='password' autoComplete='new-password' value={newPasswordConfirmation} onChange={event => setNewPasswordConfirmation(event.target.value)} />
              </FormControl>
              <Button
                loading={props.busy}
                disabled={!recoveryKey || !strength.acceptable || newPassword !== newPasswordConfirmation}
                onClick={() => void props.onRecovery(recoveryKey, newPassword)}
              >
                Recover vault
              </Button>
            </Stack>
          </TabPanel>
        </Tabs>
        {props.error && <Alert color='danger'>{props.error}</Alert>}
        <Button variant='plain' color='neutral' onClick={() => void props.onLogout()}>Sign out</Button>
      </Stack>
    </Sheet>
  );
}
