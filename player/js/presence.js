// 설치한 앱 창이 열려 있는지 (같은 origin의 브라우저 탭에서 BroadcastChannel로 묻는다)
//   앱 창만 대답하므로 다른 브라우저 탭이 열려 있어도 헷갈리지 않는다.

const CHANNEL = 'bebeam.presence';

/** 앱 창에서 부른다: 물어보면 대답한다. 돌려준 함수로 그만둔다 */
export function answerAsApp() {
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = ({ data }) => {
    if (data?.type === 'ping') ch.postMessage({ type: 'pong', id: data.id });
  };
  return () => ch.close();
}

/** 앱 창이 timeoutMs 안에 대답하면 true */
export function isAppRunning(timeoutMs = 500) {
  if (typeof BroadcastChannel !== 'function') return Promise.resolve(false);
  const ch = new BroadcastChannel(CHANNEL);
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const done = (running) => {
      clearTimeout(timer);
      ch.close();
      resolve(running);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    ch.onmessage = ({ data }) => {
      if (data?.type === 'pong' && data.id === id) done(true);
    };
    ch.postMessage({ type: 'ping', id });
  });
}
