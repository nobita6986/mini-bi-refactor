import type { PublicJob } from "../jobs-contract";
export type SpatialCompany={company_key:string;company_name:string;customer_name:string;industrial_park_code:string;jobs:PublicJob[]};
export type SpatialPark={industrial_park_code:string;industrial_park_name:string;province_code:string;company_count:number;companies:SpatialCompany[];job_count:number};
export function buildBiSpatialHierarchy(jobs:PublicJob[]):{industrial_parks:SpatialPark[];companies:SpatialCompany[];jobs:PublicJob[]};
