// Simple async queue — ensures only one sync runs at a time
// and collapses multiple pending webhook triggers into one

let running = false;
let pending = null; // holds { fn, resolve, reject } for next queued call

export async function enqueue(fn) {
  if (running) {
    // If something is already pending, replace it (debounce)
    if (pending) {
      pending.resolve(null); // let the old caller go
    }
    return new Promise((resolve, reject) => {
      pending = { fn, resolve, reject };
    });
  }

  running = true;
  try {
    return await fn();
  } finally {
    running = false;
    if (pending) {
      const next = pending;
      pending = null;
      // Run next in background
      enqueue(next.fn).then(next.resolve).catch(next.reject);
    }
  }
}
