import EventEmitter from 'events';
import { Event, getPublicKey, nip04 } from 'nostr-tools';

import { isValidRequest, NostrRPC } from './rpc';

export interface Metadata {
  name: string;
  url: string;
  description?: string;
  icons?: string[];
}

export class ConnectURI {
  target: string;
  metadata: Metadata;
  relay: string;

  static fromURI(uri: string): ConnectURI {
    const url = new URL(uri);
    const target = url.hostname || url.pathname.substring(2);
    if (!target) throw new Error('Invalid connect URI: missing target');
    const relay = url.searchParams.get('relay');
    if (!relay) {
      throw new Error('Invalid connect URI: missing relay');
    }
    const metadata = url.searchParams.get('metadata');
    if (!metadata) {
      throw new Error('Invalid connect URI: missing metadata');
    }

    /* eslint-disable @typescript-eslint/no-unused-vars */
    try {
      const md = JSON.parse(metadata);
      return new ConnectURI({ target, metadata: md, relay });
    } catch (ignore) {
      throw new Error('Invalid connect URI: metadata is not valid JSON');
    }
  }

  constructor({
    target,
    metadata,
    relay,
  }: {
    target: string;
    metadata: Metadata;
    relay: string;
  }) {
    this.target = target;
    this.metadata = metadata;
    this.relay = relay;
  }

  toString() {
    return `nostrconnect://${this.target}?metadata=${encodeURIComponent(
      JSON.stringify(this.metadata)
    )}&relay=${encodeURIComponent(this.relay)}`;
  }

  async approve(secretKey: string): Promise<void> {
    const rpc = new NostrRPC({
      relay: this.relay,
      secretKey,
    });
    await rpc.call(
      {
        target: this.target,
        request: {
          method: 'connect',
          params: [getPublicKey(secretKey)],
        },
      },
      { skipResponse: true }
    );
  }

  async reject(secretKey: string): Promise<void> {
    const rpc = new NostrRPC({
      relay: this.relay,
      secretKey,
    });
    await rpc.call(
      {
        target: this.target,
        request: {
          method: 'disconnect',
          params: [],
        },
      },
      { skipResponse: true }
    );
  }
}

export class Connect {
  rpc: NostrRPC;
  target?: string;
  events = new EventEmitter();

  constructor({
    target,
    relay,
    secretKey,
  }: {
    secretKey: string;
    target?: string;
    relay?: string;
  }) {
    this.rpc = new NostrRPC({ relay, secretKey });
    if (target) {
      this.target = target;
    }
  }

  async init() {
    const sub = await this.rpc.listen();
    sub.on('event', async (event: Event) => {
      let payload;
      /* eslint-disable @typescript-eslint/no-unused-vars */
      try {
        const plaintext = await nip04.decrypt(
          this.rpc.self.secret,
          event.pubkey,
          event.content
        );
        if (!plaintext) throw new Error('failed to decrypt event');
        payload = JSON.parse(plaintext);
      } catch (ignore) {
        return;
      }

      // ignore all the events that are not NostrRPCRequest events
      if (!isValidRequest(payload)) return;

      switch (payload.method) {
        case 'connect': {
          if (!payload.params || payload.params.length !== 1)
            throw new Error('connect: missing pubkey');
          const [pubkey] = payload.params;
          this.target = pubkey;
          this.events.emit('connect', pubkey);
          break;
        }
        case 'disconnect': {
          this.target = undefined;
          this.events.emit('disconnect');
          break;
        }
        default:
      }
    });
  }

  on(evt: 'connect' | 'disconnect', cb: (...args: any[]) => void) {
    this.events.on(evt, cb);
  }
  off(evt: 'connect' | 'disconnect', cb: (...args: any[]) => void) {
    this.events.off(evt, cb);
  }

  async disconnect(): Promise<void> {
    if (!this.target) throw new Error('Not connected');

    // notify the UI that we are disconnecting
    this.events.emit('disconnect');

    try {
      await this.rpc.call(
        {
          target: this.target,
          request: {
            method: 'disconnect',
            params: [],
          },
        },
        { skipResponse: true }
      );
    } catch (error) {
      throw new Error('Failed to disconnect');
    }

    this.target = undefined;
  }

  async getPublicKey(): Promise<string> {
    if (!this.target) throw new Error('Not connected');

    const response = await this.rpc.call({
      target: this.target,
      request: {
        method: 'get_public_key',
        params: [],
      },
    });
    return response as string;
  }

  async signEvent(event: Event): Promise<string> {
    if (!this.target) throw new Error('Not connected');

    const signature = await this.rpc.call({
      target: this.target,
      request: {
        method: 'sign_event',
        params: [event],
      },
    });

    return signature as string;
  }

  async getRelays(): Promise<{
    [url: string]: { read: boolean; write: boolean };
  }> {
    throw new Error('Not implemented');
  }

  nip04 = {
    encrypt: async (_pubkey: string, _plaintext: string): Promise<string> => {
      throw new Error('Not implemented');
    },
    decrypt: async (_pubkey: string, _ciphertext: string): Promise<string> => {
      throw new Error('Not implemented');
    },
  };
}
