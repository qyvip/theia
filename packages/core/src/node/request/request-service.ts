/********************************************************************************
 * Copyright (C) 2022 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import 'reflect-metadata';
import * as http from 'http';
import * as https from 'https';
import { parse as parseUrl } from 'url';
import { getProxyAgent, ProxyAgent } from './proxy';
import { CancellationToken } from 'vscode-languageserver-protocol';
import { createGunzip } from 'zlib';
import { injectable } from 'inversify';

export interface Headers {
    [header: string]: string;
}

export interface RawRequestFunction {
    (options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void): http.ClientRequest;
}

export interface RequestOptions {
    type?: string;
    url?: string;
    user?: string;
    password?: string;
    headers?: Headers;
    timeout?: number;
    data?: string;
    followRedirects?: number;
    proxyAuthorization?: string;
    agent?: ProxyAgent;
    strictSSL?: boolean;
    getRawRequest?(options: RequestOptions): RawRequestFunction;
}

export interface RequestContext {
    res: {
        headers: Headers;
        statusCode?: number;
    };
    asStream(): NodeJS.ReadableStream;
    asText(): string;
    asJSON<T = {}>(): T;
}

@injectable()
export class RequestService {

    proxyUrl?: string;
    strictSSL?: boolean;
    authorization?: string;

    protected getNodeRequest(options: RequestOptions): RawRequestFunction {
        const endpoint = parseUrl(options.url!);
        const module = endpoint.protocol === 'https:' ? https : http;
        return module.request;
    }

    protected processOptions(options: RequestOptions): RequestOptions {
        const { proxyUrl, strictSSL } = this;
        const agent = options.agent ? options.agent : getProxyAgent(options.url || '', process.env, { proxyUrl, strictSSL });

        options.agent = agent;
        options.strictSSL = options.strictSSL ?? strictSSL;

        if (this.authorization) {
            options.headers = {
                ...(options.headers || {}),
                'Proxy-Authorization': this.authorization
            };
        }

        return options;
    }

    request(options: RequestOptions, token = CancellationToken.None): Promise<RequestContext> {
        options = this.processOptions(options);

        const endpoint = parseUrl(options.url!);
        const rawRequest = options.getRawRequest
            ? options.getRawRequest(options)
            : this.getNodeRequest(options);

        const opts: https.RequestOptions = {
            hostname: endpoint.hostname,
            port: endpoint.port ? parseInt(endpoint.port) : (endpoint.protocol === 'https:' ? 443 : 80),
            protocol: endpoint.protocol,
            path: endpoint.path,
            method: options.type || 'GET',
            headers: options.headers,
            agent: options.agent,
            rejectUnauthorized: !!options.strictSSL
        };

        if (options.user && options.password) {
            opts.auth = options.user + ':' + options.password;
        }

        return new Promise((resolve, reject) => {
            const req = rawRequest(opts, res => {
                const followRedirects: number = options.followRedirects ?? 3;
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && followRedirects > 0 && res.headers['location']) {
                    this.request({
                        ...options,
                        url: res.headers['location'],
                        followRedirects: followRedirects - 1
                    }, token).then(resolve, reject);
                } else {
                    let stream: NodeJS.ReadableStream = res;

                    if (res.headers['content-encoding'] === 'gzip') {
                        stream = res.pipe(createGunzip());
                    }

                    let body = '';
                    stream.on('data', chunk => {
                        body += chunk;
                    });
                    stream.on('error', err => {
                        reject(err);
                    });
                    stream.on('end', () => {
                        resolve({
                            res: {
                                headers: res.headers as Headers,
                                statusCode: res.statusCode
                            },
                            asStream: () => stream,
                            asText: () => body,
                            asJSON: () => JSON.parse(body)
                        });
                    });
                }
            });

            req.on('error', reject);

            if (options.timeout) {
                req.setTimeout(options.timeout);
            }

            if (options.data) {
                req.write(options.data);
            }

            req.end();

            token.onCancellationRequested(() => {
                req.abort();
                reject();
            });
        });
    }
}
