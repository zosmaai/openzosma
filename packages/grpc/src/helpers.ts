import { ChannelCredentials, Server, ServerCredentials } from "@grpc/grpc-js"
import { GrpcTransport } from "@protobuf-ts/grpc-transport"

export interface GrpcChannelOptions {
	host: string
	port: number
}

export function createGrpcChannel(options: GrpcChannelOptions): GrpcTransport {
	return new GrpcTransport({
		host: `${options.host}:${options.port}`,
		channelCredentials: ChannelCredentials.createInsecure(),
	})
}

export interface GrpcServerOptions {
	host?: string
	port: number
}

export function createGrpcServer(): Server {
	return new Server()
}

export async function startGrpcServer(server: Server, options: GrpcServerOptions): Promise<void> {
	const host = options.host ?? "0.0.0.0"
	const address = `${host}:${options.port}`

	return new Promise((resolve, reject) => {
		server.bindAsync(address, ServerCredentials.createInsecure(), (err) => {
			if (err) {
				reject(err)
				return
			}
			console.log(`gRPC server listening on ${address}`)
			resolve()
		})
	})
}
