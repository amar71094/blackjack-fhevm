import { useReadContract } from 'wagmi';
import { blackjackContract } from '@/lib/contracts';

const BANK_POLL_INTERVAL = 60_000;

export const useBankHealth = () => {
  const {
    data,
    isFetching,
    refetch
  } = useReadContract({
    ...blackjackContract,
    functionName: 'getBankHealth',
    query: {
      enabled: Boolean(blackjackContract.address),
      refetchInterval: BANK_POLL_INTERVAL
    }
  });

  const chipsFloat = data?.[0];
  const ethBackedChips = data?.[1];
  const solvent = data?.[2];

  const isLow =
    chipsFloat !== undefined &&
    ethBackedChips !== undefined &&
    (chipsFloat > ethBackedChips || ethBackedChips < chipsFloat / 2n);

  return {
    chipsFloat,
    ethBackedChips,
    solvent,
    isLow: Boolean(isLow),
    isLoading: isFetching,
    refetch
  };
};