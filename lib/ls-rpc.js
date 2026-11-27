/**
 * Language Server Connect-RPC Transport Helper.
 * Executes Connect-RPC POST {} calls over loopback HTTP with fail-fast boundary validation,
 * 404 path fallback, timeout enforcement, and deterministic stream/socket error settlement.
 */

import http from "node:http";

/**
 * Validates Connect-RPC call arguments fail-fast.
 * @param {*} port
 * @param {*} csrfToken
 * @param {*} paths
 */
function validateRpcArguments(port, csrfToken, paths) {
  if (typeof port !== "number" || Number.isNaN(port)) {
    throw new TypeError("RPC port must be an integer between 1 and 65535.");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`RPC port must be an integer between 1 and 65535 (received ${port}).`);
  }

  if (typeof csrfToken !== "string") {
    throw new TypeError("csrfToken must be a non-empty string.");
  }
  const trimmedCsrf = csrfToken.trim();
  if (!trimmedCsrf) {
    throw new RangeError("csrfToken must be a non-empty string.");
  }
  if (/[\x00-\x1f\x7f]/.test(csrfToken)) {
    throw new RangeError("csrfToken must not contain control characters.");
  }

  if (!Array.isArray(paths)) {
    throw new TypeError("paths must be a non-empty array of RPC path strings starting with '/'.");
  }
  if (paths.length === 0) {
    throw new RangeError("paths must be a non-empty array of RPC path strings starting with '/'.");
  }
  for (let i = 0; i < paths.length; i += 1) {
    const entry = paths[i];
    if (typeof entry !== "string") {
      throw new TypeError(`paths[${i}] must be a non-empty string starting with '/'.`);
    }
    const trimmed = entry.trim();
    if (!trimmed || !trimmed.startsWith("/")) {
      throw new RangeError(`paths[${i}] must be a non-empty string starting with '/' (received "${entry}").`);
    }
    if (/[\s\x00-\x1f\x7f]/.test(entry)) {
      throw new RangeError(`paths[${i}] must not contain whitespace or control characters (received "${entry}").`);
    }
  }
}

/**
 * Performs a Connect-RPC POST {} request against candidate endpoint paths.
 * @param {number} port
 * @param {string} csrfToken
 * @param {Array<string>} paths
 * @param {string} [label="Quota RPC"]
 * @param {string} [methodName="RetrieveUserQuotaSummary"]
 * @param {{ body?: Object, timeoutMs?: number }} [options={}]
 * @returns {Promise<Object>}
 */
export async function makeConnectRpcCall(
  port,
  csrfToken,
  paths,
  label = "Quota RPC",
  methodName = "RetrieveUserQuotaSummary",
  options = {}
) {
  validateRpcArguments(port, csrfToken, paths);
  if (options !== null && options !== undefined && (typeof options !== "object" || Array.isArray(options))) {
    throw new TypeError("RPC options must be a plain object.");
  }
  const rawTimeout = options?.timeoutMs;
  let timeoutMs = 5000;
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== "number" || Number.isNaN(rawTimeout)) {
      throw new TypeError("options.timeoutMs must be a positive finite integer.");
    }
    if (!Number.isSafeInteger(rawTimeout) || rawTimeout <= 0) {
      throw new RangeError(`options.timeoutMs must be a positive finite integer (received ${rawTimeout}).`);
    }
    timeoutMs = rawTimeout;
  }
  const requestBody = options?.body !== undefined ? options.body : {};
  const normalizedCsrfToken = csrfToken.trim();
  const normalizedPaths = paths.map((p) => p.trim());

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(requestBody);
    let settled = false;

    const finishResolve = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const tryPath = (idx) => {
      if (settled) return;
      if (idx >= normalizedPaths.length) {
        const err = new Error(`Failed to call ${methodName} on port ${port}: endpoint not found`);
        err.isNotFound = true;
        err.statusCode = 404;
        return finishReject(err);
      }

      let attemptDone = false;
      const reqPath = normalizedPaths[idx];
      let req;
      try {
        req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: reqPath,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-codeium-csrf-token": normalizedCsrfToken,
              "Connect-Protocol-Version": "1",
              "Content-Length": Buffer.byteLength(payload)
            },
            timeout: timeoutMs
          },
          (res) => {
            if (res.statusCode === 404 && idx + 1 < normalizedPaths.length) {
              attemptDone = true;
              res.resume();
              return tryPath(idx + 1);
            }

            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () => {
              if (attemptDone) return;
              attemptDone = true;
              if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                  finishResolve(JSON.parse(data));
                } catch (err) {
                  finishReject(new Error(`Malformed JSON response from ${label}: ${err.message}`));
                }
              } else {
                const err = new Error(`${label} responded with status code ${res.statusCode}: ${data}`);
                err.statusCode = res.statusCode;
                if (res.statusCode === 404) err.isNotFound = true;
                finishReject(err);
              }
            });
            res.on("error", (err) => {
              if (attemptDone) return;
              attemptDone = true;
              const wrapped = new Error(`Response stream error calling ${label} on 127.0.0.1:${port}: ${err.message}`);
              wrapped.isNetworkError = true;
              wrapped.cause = err;
              finishReject(wrapped);
            });
            res.on("close", () => {
              if (attemptDone || res.complete) return;
              attemptDone = true;
              const wrapped = new Error(`Connection closed prematurely calling ${label} on 127.0.0.1:${port}`);
              wrapped.isNetworkError = true;
              finishReject(wrapped);
            });
          }
        );

        req.on("error", (err) => {
          if (attemptDone) return;
          attemptDone = true;
          const wrapped = new Error(`Connection error calling ${label} on 127.0.0.1:${port}: ${err.message}`);
          wrapped.isNetworkError = true;
          wrapped.cause = err;
          finishReject(wrapped);
        });

        req.on("timeout", () => {
          if (attemptDone) return;
          attemptDone = true;
          const timeoutErr = new Error(`Timeout calling ${label} on 127.0.0.1:${port}`);
          timeoutErr.isNetworkError = true;
          req.destroy(timeoutErr);
          finishReject(timeoutErr);
        });

        req.write(payload);
        req.end();
      } catch (err) {
        attemptDone = true;
        if (req && !req.destroyed) {
          req.destroy();
        }
        return finishReject(err);
      }
    };

    tryPath(0);
  });
}
