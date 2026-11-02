import type { ModelReport } from './model-validation.mjs';
import type { ModelComparison } from './model-compatibility.mjs';
export interface ModelPublishInput { request_key:string; expected_revision:string; expected_release_id:string|null; visibility:'public' }
export interface Publisher { issuer:string; publisher_id:string; namespace:string; trust:ReleaseTrust|null }
export interface ReleaseTrust { version:1;issuer:string;publisher_id:string;namespace:string;signing_key_id:string;public_key:string }
export interface ModelPublication {
  artifact:{version:1;algorithm:'Ed25519';signing_key_id:string;signature:string;statement:{
    issuer:string;publisher_id:string;namespace:string;product_id:string;release_id:string;source_revision:string;source_document_digest:string;
    visibility:'public';validator:string;compatibility_checker:string;model_revision:string;model:Record<string,unknown>;
    baseline:{release_id:string;model_revision:string;model_version:string}|null;published_at:string;
  }};
  trust:ReleaseTrust;
}
export interface ModelPublishOperation {
  operation_id:string;principal_id:string;product_id:string;request_digest:string;request:ModelPublishInput;
  status:'published'|'rejected'|'conflict';reason:string|null;source_revision:string;source_document_digest:string;
  head_release_id:string|null;validation:ModelReport|null;compatibility:ModelComparison|null;release:ModelPublication|null;created_at:string;
}
export function validPublishInput(value:unknown):value is ModelPublishInput;
export function parsePublishInput(text:string):ModelPublishInput;
export function verifyPublisher(value:unknown,principal:string):Promise<Publisher>;
export function verifyPublication(value:unknown,expected?:{product_id?:string;release_id?:string;publisher?:Publisher;principal?:string}):Promise<ModelPublication>;
export function verifyPublishOperation(value:unknown,principal:string,expected?:{product_id:string;request:ModelPublishInput}):Promise<ModelPublishOperation>;
