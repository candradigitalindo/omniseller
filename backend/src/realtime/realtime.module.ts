import { Module } from "@nestjs/common";
import { IdentityModule } from "../modules/identity/identity.module";
import { RealtimeGateway } from "./realtime.gateway";

/** Socket.IO on the api's HTTP server (technology doc 7.3); api process only. Pushes go through `REALTIME`. */
@Module({ imports: [IdentityModule], providers: [RealtimeGateway] })
export class RealtimeModule {}
