import type {
  HistoryRequest,
  HistoryResponse,
  HistoryResult,
} from '@dashdot/common';
import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';

export const useHistory = (
  socket: Socket | undefined,
  request: HistoryRequest,
) => {
  const [data, setData] = useState<HistoryResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const { from, to, points = 1000 } = request;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt deliberately reloads the same range after Retry.
  useEffect(() => {
    if (!socket) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () => {
      setLoading(true);
      clearTimeout(timer);
      timer = setTimeout(() => {
        socket
          .timeout(10_000)
          .emit(
            'history',
            { from, to, points },
            (failure: Error | null, response: HistoryResult) => {
              if (!active) return;
              setLoading(false);
              if (failure || !response)
                setError(
                  'Unable to load history. Check the server connection.',
                );
              else if ('error' in response) setError(response.error);
              else {
                setData(response);
                setError(undefined);
              }
            },
          );
      }, 180);
    };
    const disconnected = () => {
      setError('Connection lost. Reconnecting…');
      setLoading(false);
    };
    socket.on('connect', load);
    socket.on('disconnect', disconnected);
    if (socket.connected) load();
    else disconnected();
    return () => {
      active = false;
      clearTimeout(timer);
      socket.off('connect', load);
      socket.off('disconnect', disconnected);
    };
  }, [socket, from, to, points, attempt]);
  return {
    data,
    error,
    loading,
    retry: () => setAttempt((value) => value + 1),
  };
};
