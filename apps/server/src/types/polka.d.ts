declare module 'polka' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  export interface Request extends IncomingMessage {
    params: Record<string, string>;
    query: Record<string, string | string[]>;
    body?: any;
    token?: string;
  }

  export type Response = ServerResponse & {
    statusCode: number;
  };

  export type NextHandler = (err?: any) => void;

  export type Middleware = (
    req: Request,
    res: Response,
    next: NextHandler
  ) => void | Promise<void>;

  export type RouteHandler = (
    req: Request,
    res: Response,
    next?: NextHandler
  ) => void | Promise<void>;

  export interface PolkaInstance {
    use(...handlers: (Middleware | RouteHandler | PolkaInstance)[]): this;
    use(base: string, ...handlers: (Middleware | RouteHandler | PolkaInstance)[]): this;
    get(pattern: string, ...handlers: RouteHandler[]): this;
    post(pattern: string, ...handlers: RouteHandler[]): this;
    put(pattern: string, ...handlers: RouteHandler[]): this;
    delete(pattern: string, ...handlers: RouteHandler[]): this;
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
