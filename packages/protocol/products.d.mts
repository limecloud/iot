export function parseDraftJSON(text:string, envelope?:boolean): Record<string,unknown>;
export function parseBoundedJSON(text:string, limits?:{maxBytes?:number;maxDepth?:number;maxNodes?:number}): unknown;
export function sameJSON(a:unknown, b:unknown): boolean;
export function validProductInput(value:unknown, saving:boolean): boolean;
export function validProduct(value:unknown, principal:string): boolean;
export function validProductOperation(value:unknown, principal:string, expected?:{kind:string;product_id:string|null;request:unknown}): boolean;
