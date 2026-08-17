import * as React from 'react';
import { Alert, Button, FormControl, FormHelperText, FormLabel, Input, Sheet, Stack, Typography } from '@mui/joy';

import { privateProVaultPasswordStrength } from '../vault/ProviderPrivateProVault';


export interface PrivateProVaultSetupProps {
  busy: boolean;
  error: string | null;
  recoveryKey: string | null;
  onSetup(password: string): Promise<void>;
  onRecoveryConfirmed(): Promise<void>;
}

function recoveryGroups(value: string): string[] {
  return value.split('-').filter(Boolean);
}

export function PrivateProVaultSetup(props: PrivateProVaultSetupProps) {
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [recoveryConfirmation, setRecoveryConfirmation] = React.useState('');
  const strength = privateProVaultPasswordStrength(password);
  const passwordsMatch = password === confirmation;
  const groups = props.recoveryKey ? recoveryGroups(props.recoveryKey) : [];
  const requestedGroups = groups.length >= 4 ? [groups[1], groups.at(-2)] : [];
  const expectedConfirmation = requestedGroups.join(' ').toUpperCase();
  const enteredConfirmation = recoveryConfirmation.trim().replace(/[\s-]+/g, ' ').toUpperCase();

  return (
    <Sheet sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Stack spacing={2} sx={{ width: 'min(100%, 520px)' }}>
        <Typography level='h2'>Protect your private vault</Typography>
        {!props.recoveryKey ? <>
          <Typography textColor='text.secondary'>Choose a long password. It never leaves this browser.</Typography>
          <FormControl error={!!password && !strength.acceptable}>
            <FormLabel>Vault password</FormLabel>
            <Input type='password' autoComplete='new-password' value={password} onChange={event => setPassword(event.target.value)} />
            <FormHelperText>{strength.label}</FormHelperText>
          </FormControl>
          <FormControl error={!!confirmation && !passwordsMatch}>
            <FormLabel>Confirm password</FormLabel>
            <Input type='password' autoComplete='new-password' value={confirmation} onChange={event => setConfirmation(event.target.value)} />
            {!!confirmation && !passwordsMatch && <FormHelperText>Passwords do not match.</FormHelperText>}
          </FormControl>
          {props.error && <Alert color='danger'>{props.error}</Alert>}
          <Button loading={props.busy} disabled={!strength.acceptable || !passwordsMatch} onClick={() => void props.onSetup(password)}>
            Create encrypted vault
          </Button>
        </> : <>
          <Alert color='warning'>Save this recovery key now. It will not be shown again.</Alert>
          <Typography component='code' sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere', userSelect: 'all' }}>{props.recoveryKey}</Typography>
          <Typography level='body-sm'>Enter group 2 and group {Math.max(1, groups.length - 1)}, separated by a space.</Typography>
          <FormControl>
            <FormLabel>Recovery key groups</FormLabel>
            <Input autoComplete='off' value={recoveryConfirmation} onChange={event => setRecoveryConfirmation(event.target.value)} />
          </FormControl>
          <Button loading={props.busy} disabled={enteredConfirmation !== expectedConfirmation} onClick={() => void props.onRecoveryConfirmed()}>
            Save recovery key
          </Button>
        </>}
      </Stack>
    </Sheet>
  );
}
