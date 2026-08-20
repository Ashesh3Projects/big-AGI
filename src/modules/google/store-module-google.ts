import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPrivateProPortableLocalStorageOptions } from '~/modules/private-pro/persistence/privatePro.persistence';


interface ModuleGoogleSearchStore {

  // Google Custom Search settings

  googleCloudApiKey: string;
  setGoogleCloudApiKey: (googleApiKey: string) => void;

  googleCSEId: string;
  setGoogleCSEId: (cseId: string) => void;

  restrictToDomain: string;
  setRestrictToDomain: (domain: string) => void;

}

export const useGoogleSearchStore = create<ModuleGoogleSearchStore>()(
  persist(
    (set) => ({

      // Google Custom Search settings

      googleCloudApiKey: '',
      setGoogleCloudApiKey: (googleApiKey: string) => set({ googleCloudApiKey: googleApiKey }),

      googleCSEId: '',
      setGoogleCSEId: (cseId: string) => set({ googleCSEId: cseId }),

      restrictToDomain: '',
      setRestrictToDomain: (domain: string) => set({ restrictToDomain: domain }),

    }),
    {
      name: 'app-module-google-search',
      ...createPrivateProPortableLocalStorageOptions<ModuleGoogleSearchStore>(),
    }),
);


/// Private sync adapters

export interface GoogleSyncState {
  googleCloudApiKey: string;
  googleCSEId: string;
  restrictToDomain: string;
}

export function googleSyncSnapshot(): GoogleSyncState {
  const { googleCloudApiKey, googleCSEId, restrictToDomain } = useGoogleSearchStore.getState();
  return { googleCloudApiKey, googleCSEId, restrictToDomain };
}

export function googleSyncApply(value: GoogleSyncState): void {
  useGoogleSearchStore.setState(structuredClone(value));
}

export function googleSyncReset(): void {
  useGoogleSearchStore.setState({ googleCloudApiKey: '', googleCSEId: '', restrictToDomain: '' });
}

export function googleSyncSubscribe(listener: () => void): () => void {
  return useGoogleSearchStore.subscribe(listener);
}
