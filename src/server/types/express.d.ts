/// <reference types="express" />

declare global {
  namespace Express {
    interface Request {
      body: any;
      params: { [key: string]: string };
      query: { [key: string]: string };
    }
  }
}

export {};
