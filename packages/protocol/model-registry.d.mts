import type { ModelPublication, ReleaseTrust } from './model-publication.mjs';
export type Artifact = ModelPublication['artifact'];
export type ModelChange =
  | {type:'trust.add';trust:ReleaseTrust;expected_signing_key_id:string}
  | {type:'trust.revoke';trust_id:string;expected_revision:string}
  | {type:'models.install';trust_id:string;artifact:Artifact;expected_release_id:string|null}
  | {type:'devices.bind';device_id:string;installation_id:string;expected_model_revision:string|null;expected_binding_revision:string|null};
export interface ModelRequest {space_id:string;idempotency_key:string;change:ModelChange}
export interface PublisherTrust {trust_id:string;revision:string;trust:ReleaseTrust;active:boolean;created_at:string;revoked_at:string|null}
export interface Installation {installation_id:string;trust_id:string;artifact:Artifact;installed_at:string}
export interface DeviceBinding {device_id:string;model_revision:string;installation_id:string;revision:string;bound_at:string}
export interface BindingView {device_id:string;model_revision:string|null;binding:DeviceBinding|null;trust_active:boolean}
export interface ModelOperation {
  operation_id:string;request:ModelRequest;request_digest:string;status:'applied'|'conflict'|'rejected';reason:string|null;created_at:string;
  result:{type:'trust';value:PublisherTrust}|{type:'installation';value:Installation}|{type:'binding';value:DeviceBinding}|null;
}
export function validModelChange(value:unknown):value is ModelChange;
export function parseModelChange(text:string):ModelChange;
export function verifyPublisherTrust(value:unknown):Promise<PublisherTrust>;
export function verifyModelInstallation(value:unknown):Promise<Installation>;
export function verifyModelBinding(value:unknown,deviceID:string):BindingView;
export function verifyModelOperation(value:unknown,expected?:ModelRequest):Promise<ModelOperation>;
export function sameModelRequest(one:unknown,two:unknown):boolean;
