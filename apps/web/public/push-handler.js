/* global self -- the ServiceWorkerGlobalScope that imports this file */
/*
 * QueueBridge turn-alert push handler (M5.4; REQ-F14.5; design §12.5.5, §12.5.7; ADR-013).
 *
 * Imported by the generated service worker (`workbox.importScripts`), so the M3 offline shell
 * and caching rules are untouched. The service worker has no localStorage and holds NO bearer
 * credential: it needs only the payload, which carries a non-secret subscription reference
 * (`ref`), the public ticket code, the counter label, the committed call sequence and a public
 * recovery path. Notification identity is the reference, never the public code alone.
 *
 * push:  a focused, visible QueueBridge window gets the payload as a message (the page decides
 *        whether it is the ticket it shows) and no system notification is shown; otherwise a
 *        notification with tag `qb-call-<ref>` (one per ticket and device; a retry replaces it).
 * click: focus a window and navigate it, or open one, at `/ticket/<code>?ref=<ref>&seq=<n>&rp=…`.
 * The first-party acknowledgement is sent by the PAGE (it holds the status token), never here.
 * Delivery and vibration are best effort and depend on the browser and the device.
 */
(function (self) {
  'use strict';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var CODE = /^[A-Za-z0-9-]{1,16}$/;
  var RP = /^\/recover\/[A-Za-z0-9._~%-]+\/[A-Za-z0-9._~%-]+\/[A-Za-z0-9._~%-]+$/;

  /** The v2 payload, validated field by field; anything else is null. */
  function parsePayload(text) {
    var p;
    try {
      p = JSON.parse(text);
    } catch {
      return null;
    }
    if (!p || typeof p !== 'object') return null;
    if (p.v !== 2 || p.type !== 'ticket.called') return null;
    if (typeof p.ref !== 'string' || !UUID.test(p.ref)) return null;
    if (typeof p.code !== 'string' || !CODE.test(p.code)) return null;
    if (typeof p.seq !== 'number' || !(p.seq > 0) || Math.floor(p.seq) !== p.seq) return null;
    return {
      ref: p.ref.toLowerCase(),
      code: p.code,
      seq: p.seq,
      counter: typeof p.counter === 'string' ? p.counter.slice(0, 120) : '',
      rp: typeof p.rp === 'string' && RP.test(p.rp) ? p.rp : null,
    };
  }

  /** Where a click goes: built from the reference, with the code only as a display value. */
  function openPath(p) {
    if (!p || !UUID.test(p.ref || '') || !CODE.test(p.code || '')) return '/';
    var path = '/ticket/' + encodeURIComponent(p.code) + '?ref=' + encodeURIComponent(p.ref);
    if (typeof p.seq === 'number' && p.seq > 0) path += '&seq=' + String(p.seq);
    if (p.rp && RP.test(p.rp)) path += '&rp=' + encodeURIComponent(p.rp);
    return path;
  }

  function notificationFor(p) {
    return {
      title: 'Your turn: ' + p.code,
      options: {
        body:
          (p.counter ? 'Please go to ' + p.counter + '. ' : 'Please go to the counter. ') +
          'Open to see your ticket.',
        tag: 'qb-call-' + p.ref,
        renotify: true,
        requireInteraction: true,
        // Best effort: many devices ignore this; nothing relies on it
        vibrate: [200, 100, 200],
        icon: '/icons/icon-192.png',
        data: { ref: p.ref, code: p.code, seq: p.seq, rp: p.rp },
      },
    };
  }

  /** A window the visitor is looking at right now. */
  function pickFocused(list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c && c.focused === true && c.visibilityState === 'visible') return c;
    }
    return null;
  }

  /** Returns what happened: 'handoff' | 'shown' | 'generic'. */
  function handlePush(text, clientsApi, registration) {
    var p = parsePayload(text);
    if (!p) {
      // Not ours or malformed: a neutral notice that opens the start page, nothing else
      return registration
        .showNotification('QueueBridge', {
          body: 'Open QueueBridge to check your ticket.',
          tag: 'qb-generic',
        })
        .then(function () {
          return 'generic';
        });
    }
    return clientsApi.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      var focused = pickFocused(list || []);
      if (focused) {
        focused.postMessage({
          type: 'qb-turn-alert',
          ref: p.ref,
          code: p.code,
          seq: p.seq,
          counter: p.counter,
          rp: p.rp,
        });
        return 'handoff';
      }
      var n = notificationFor(p);
      return registration.showNotification(n.title, n.options).then(function () {
        return 'shown';
      });
    });
  }

  /** Returns the path that was focused/navigated or opened. */
  function handleClick(data, clientsApi, origin) {
    var path = openPath(data);
    return clientsApi.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      var same = null;
      for (var i = 0; i < (list || []).length; i++) {
        var c = list[i];
        if (c && typeof c.url === 'string' && c.url.indexOf(origin) === 0) {
          same = c;
          break;
        }
      }
      if (same && typeof same.navigate === 'function') {
        return Promise.resolve(same.focus())
          .then(function () {
            return same.navigate(path);
          })
          .then(
            function () {
              return path;
            },
            function () {
              // an uncontrolled window cannot be navigated from here: open a new one
              return Promise.resolve(clientsApi.openWindow(path)).then(function () {
                return path;
              });
            },
          );
      }
      return Promise.resolve(clientsApi.openWindow(path)).then(function () {
        return path;
      });
    });
  }

  self.__qbPush = {
    parsePayload: parsePayload,
    openPath: openPath,
    notificationFor: notificationFor,
    pickFocused: pickFocused,
    handlePush: handlePush,
    handleClick: handleClick,
  };

  if (typeof self.addEventListener === 'function' && self.registration) {
    self.addEventListener('push', function (event) {
      var text = '';
      try {
        text = event.data ? event.data.text() : '';
      } catch {
        text = '';
      }
      event.waitUntil(handlePush(text, self.clients, self.registration));
    });
    self.addEventListener('notificationclick', function (event) {
      var data = (event.notification && event.notification.data) || null;
      if (event.notification) event.notification.close();
      event.waitUntil(handleClick(data, self.clients, self.location.origin));
    });
  }
})(self);
