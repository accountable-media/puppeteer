/**
 * Copyright 2020 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {IsPageTargetCallback, TargetFilterCallback} from '../api/Browser.js';
import {isNode} from '../environment.js';
import {assert} from '../util/assert.js';
import {isErrorLike} from '../util/ErrorLike.js';

import {CDPBrowser} from './Browser.js';
import {Connection} from './Connection.js';
import {ConnectionTransport} from './ConnectionTransport.js';
import {getFetch} from './fetch.js';
import type {ConnectOptions} from './Puppeteer.js';
import {Viewport} from './PuppeteerViewport.js';
import {debugError} from './util.js';
/**
 * Generic browser options that can be passed when launching any browser or when
 * connecting to an existing browser instance.
 * @public
 */
export interface BrowserConnectOptions {
  /**
   * Whether to ignore HTTPS errors during navigation.
   * @defaultValue `false`
   */
  ignoreHTTPSErrors?: boolean;
  /**
   * Sets the viewport for each page.
   */
  defaultViewport?: Viewport | null;
  /**
   * Slows down Puppeteer operations by the specified amount of milliseconds to
   * aid debugging.
   */
  slowMo?: number;
  /**
   * Callback to decide if Puppeteer should connect to a given target or not.
   */
  targetFilter?: TargetFilterCallback;
  /**
   * @internal
   */
  _isPageTarget?: IsPageTargetCallback;
  /**
   * @defaultValue 'cdp'
   * @internal
   */
  protocol?: 'cdp' | 'webDriverBiDi';
  /**
   * Timeout setting for individual protocol (CDP) calls.
   *
   * @defaultValue `180_000`
   */
  protocolTimeout?: number;
}

const getWebSocketTransportClass = async () => {
  console.log('isNode', isNode);
  return isNode
    ? (await import('./NodeWebSocketTransport.js')).NodeWebSocketTransport
    : (await import('./BrowserWebSocketTransport.js'))
        .BrowserWebSocketTransport;
};

/**
 * Users should never call this directly; it's called when calling
 * `puppeteer.connect`.
 *
 * @internal
 */
export async function _connectToCDPBrowser(
  options: BrowserConnectOptions & ConnectOptions
): Promise<CDPBrowser> {
  const {
    browserWSEndpoint,
    browserURL,
    ignoreHTTPSErrors = false,
    defaultViewport = {width: 800, height: 600},
    transport,
    headers = {},
    slowMo = 0,
    targetFilter,
    _isPageTarget: isPageTarget,
    protocolTimeout,
  } = options;

  assert(
    Number(!!browserWSEndpoint) + Number(!!browserURL) + Number(!!transport) ===
      1,
    'Exactly one of browserWSEndpoint, browserURL or transport must be passed to puppeteer.connect'
  );

  let connection!: Connection;
  if (transport) {
    connection = new Connection('', transport, slowMo, protocolTimeout);
  } else if (browserWSEndpoint) {
    const WebSocketClass = await getWebSocketTransportClass();
    console.log('In common: after get class');
    const connectionTransport: ConnectionTransport =
      await WebSocketClass.create(browserWSEndpoint, headers);
    console.log('In common: create connection transport');
    connection = new Connection(
      browserWSEndpoint,
      connectionTransport,
      slowMo,
      protocolTimeout
    );
  } else if (browserURL) {
    const connectionURL = await getWSEndpoint(browserURL);
    const WebSocketClass = await getWebSocketTransportClass();
    console.log('Got the web socket class', WebSocketClass);
    const connectionTransport: ConnectionTransport =
      await WebSocketClass.create(connectionURL);
    console.log('Created connection transport', connectionTransport);
    connection = new Connection(
      connectionURL,
      connectionTransport,
      slowMo,
      protocolTimeout
    );
  }
  const version = await connection.send('Browser.getVersion');

  const product = version.product.toLowerCase().includes('firefox')
    ? 'firefox'
    : 'chrome';

  const {browserContextIds} = await connection.send(
    'Target.getBrowserContexts'
  );

  console.log('Before CDP Browser create');
  const browser = await CDPBrowser._create(
    product || 'chrome',
    connection,
    browserContextIds,
    ignoreHTTPSErrors,
    defaultViewport,
    undefined,
    () => {
      return connection.send('Browser.close').catch(debugError);
    },
    targetFilter,
    isPageTarget
  );
  return browser;
}

async function getWSEndpoint(browserURL: string): Promise<string> {
  const endpointURL = new URL('/json/version', browserURL);

  const fetch = await getFetch();
  try {
    const result = await fetch(endpointURL.toString(), {
      method: 'GET',
    });
    if (!result.ok) {
      throw new Error(`HTTP ${result.statusText}`);
    }
    const data = await result.json();
    return data.webSocketDebuggerUrl;
  } catch (error) {
    if (isErrorLike(error)) {
      error.message =
        `Failed to fetch browser webSocket URL from ${endpointURL}: ` +
        error.message;
    }
    throw error;
  }
}
