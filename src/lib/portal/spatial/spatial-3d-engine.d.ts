import type {buildBiSpatialHierarchy} from "./spatial-adapter";
export type Anchor={type:"kcn"|"company";key:string;x:number;y:number;visible:boolean;distance:number};
export class BiSpatial3DEngine {
  constructor(options:{canvas:HTMLCanvasElement;skinId:string;tileOrigin:string|null;onSelectKcn:(key:string)=>void;onSelectCompany:(key:string)=>void;onScreenAnchorsUpdate:(anchors:Anchor[])=>void;onHoverNode:(node:{type:string;key?:string;companyKey?:string;kcnCode?:string}|null)=>void});
  renderPaused:boolean;
  setHierarchyData(data:ReturnType<typeof buildBiSpatialHierarchy>,options:{preserveView:boolean}):void;
  setSkinTheme(id:string):void;flyToLevel1():void;flyToLevel2(code:string):void;flyToLevel3(company:string,side?:string):void;
  highlightNode(node:{type:"company"|"kcn";key:string}|null):void;setDayNightMode(night:boolean):void;setMapStyle(style:string):void;orbitCompanySide(side:string):void;resize():void;dispose():void;
}
