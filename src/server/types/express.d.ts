/// <reference types="express" />
import { PathValidator } from '../utils/pathValidator';

declare global {
  namespace Express {
    interface Request {
      body: any;
      params: { [key: string]: string };
      query: { [key: string]: string };
      pathValidator?: PathValidator;
    }
  }
}

export {};
