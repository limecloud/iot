export interface DiscoveryQuery {coordinator_id:string}
export interface EndpointQuery extends DiscoveryQuery {ieee_address:string}
export interface DiscoveryContext extends DiscoveryQuery {coordinator_ieee?:string;ieee_address?:string}
export interface ZigbeeNeighbor {extended_pan_id:string;ieee_address:string;network_address:number;device_type:number;rx_on_when_idle:number;relationship:number;flags:number;permit_joining:number;depth:number;link_quality:number}
export interface ZigbeeEndpoint {endpoint:number;profile_id:number;device_id:number;device_version:number;input_clusters:number[];output_clusters:number[]}
interface ObservationReport {coordinator_id:string;coordinator_ieee:string;observed_at:string;expires_at:string;protocol:'zigbee-znp';evidence:'unauthenticated_protocol'}
export interface ObservationDiscovery extends ObservationReport {scope:'coordinator_neighbors';items:ZigbeeNeighbor[]}
export interface ObservationEndpoints extends ObservationReport {ieee_address:string;network_address:number;manufacturer_code:number;endpoints:ZigbeeEndpoint[]}
export function parseObservationDiscoveryQuery(text:string,endpoints?:false):DiscoveryQuery;
export function parseObservationDiscoveryQuery(text:string,endpoints:true):EndpointQuery;
export function verifyObservationDiscovery(value:unknown,expected?:DiscoveryContext):ObservationDiscovery;
export function verifyObservationEndpoints(value:unknown,expected?:DiscoveryContext):ObservationEndpoints;
export function supportsEnvironmentEndpoint(endpoint:ZigbeeEndpoint):boolean;
export function supportsOnOffEndpoint(endpoint:ZigbeeEndpoint):boolean;
