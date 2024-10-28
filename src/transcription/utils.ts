import { Socket } from "socket.io";




export function sendWSEvent<EventType extends string, CallbackTypes extends Record<EventType, (data: any) => void>>(client: Socket, event: EventType, data: Parameters<CallbackTypes[EventType]>[0]) {
    client.emit(event, data);
}
