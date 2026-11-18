import { IncomingMessage, ServerResponse } from 'node:http';

declare module 'polka' {
  export interface Request extends IncomingMessage {
    params: Record<string, string>;
    query: Record<string, string | string[]>;
    body?: any;
    token?: string;
  }

  export type Response = ServerResponse;

  export type Middleware = (
    req: Request,
    res: Response,
    next: (err?: any) => void
  ) => void;

  export interface IError extends Error {
    status?: number;
    code?: string;
  }

  export interface PolkaInstance {
    use(...handlers: (Middleware | PolkaInstance)[]): this;
    use(base: string, ...handlers: (Middleware | PolkaInstance)[]): this;
    get(pattern: string, ...handlers: Middleware[]): this;
    post(pattern: string, ...handlers: Middleware[]): this;
    put(pattern: string, ...handlers: Middleware[]): this;
    delete(pattern: string, ...handlers: Middleware[]): this;
    listen(port?: number, host?: string, cb?: () => void): this;
    listen(port?: number, cb?: () => void): this;
    server?: any;
    handler(req: IncomingMessage, res: ServerResponse, parsed?: any): void;
  }

  export default function polka(options?: {
    server?: any;
    onError?: (err: any, req: Request, res: Response, next: any) => void;
    onNoMatch?: (req: Request, res: Response) => void;
  }): PolkaInstance;
}
