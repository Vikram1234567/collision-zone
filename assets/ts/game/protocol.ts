import * as $ from 'jquery'
import { ByteArrayInputStream } from "../util";
import { GameScene } from "./view/scene";
import { GameObjects, Scene, Input } from "phaser";
import { GameState, Player } from './gamestate';


namespace EventCode {
    export const UPDATE_PAYLOAD = 0x07
    export const PLAYER_JOIN = 0x41
    export const KILLS = 0x90
    export const HIGH_SCORES = 0x91
    export const CHAT_MSG = 0x46
}

export enum ClientState {
    UNINITIALIZED, ACTIVE, CLOSED
}

export interface PlayerInitData {
    username: string
    player_class: integer
}

export class Client {
    url: string
    socket: WebSocket
    game_state: GameState | null = null

    player_id: integer = 0
    is_player: boolean
    state: ClientState = ClientState.UNINITIALIZED

    private send_player_task: any = -1
    private input_x: number = 0
    private input_y: number = 0
    
    constructor(base_url: string, private scene: GameScene, player_data?: PlayerInitData) {
        if (player_data) {
            this.url = base_url + `?username=${player_data.username}&class=${player_data.player_class}`
            this.is_player = true
        } else {
            this.url = base_url
            this.is_player = false
        }
        this.socket = new WebSocket(this.url)
        
        this.socket.onopen = () => {
            console.info("Socket opened at", this.url)
        }
        this.socket.onmessage = (data) => {
            const stream = new ByteArrayInputStream(new ArrayBuffer(data.data))
            if (this.is_player) {
                this.player_id = stream.readShort()
                this.send_player_task = setInterval(() => {
                    this.send_player_input()
                }, 250)
            }
            this.game_state = GameState.readFromStream(stream)
            this.state = ClientState.ACTIVE
            this.socket.onmessage = (data) => {
                const stream = new ByteArrayInputStream(new ArrayBuffer(data.data))
                this.handle_active_message(stream)
            }
        }
        this.socket.onclose = (ev) => {
            clearInterval(this.send_player_task)
            this.state = ClientState.CLOSED
        }
    }

    get player(): Player | undefined {
        const state = this.game_state
        if (state) {
            return state.players.get(this.player_id)
        } else {
            return undefined
        }
    }

    private send_player_input(): void {
        const buf = new ArrayBuffer(10)
        const dv = new DataView(buf)
        dv.setUint8(0, 117)  // unreliable
        dv.setUint8(1, 0x3a)  // set_input command code
        dv.setFloat32(2, this.input_x / 10, true)
        dv.setFloat32(6, this.input_y / 10, true)
        // console.debug("sending", this.playerDx, this.playerDy)
        this.socket.send(buf)
    }

    private handle_active_message(stream: ByteArrayInputStream) {
        const event_code = stream.readByte()
        const gs = this.game_state as GameState
        switch (event_code) {
            case EventCode.PLAYER_JOIN:
                gs.applyPlayerJoinedEvents(stream)
                break
            case EventCode.KILLS:
                gs.applyPlayerKillEvents(stream)
                break
            case EventCode.UPDATE_PAYLOAD:
                gs.applyUpdatesFromStream(stream)
                break
        }
    }

    set_player_input(dx: number, dy: number): void {
        this.input_x = dx
        this.input_y = dy
    }

    send_boost() {
        const abuf = new ArrayBuffer(2)
        const view = new DataView(abuf)
        view.setUint8(0, 114)  // reliable
        view.setUint8(1, 0x52)  // event_code
        this.socket.send(abuf)
    }

    send_brake(braking: boolean) {
        const abuf = new ArrayBuffer(3)
        const view = new DataView(abuf)
        view.setUint8(0, 114)  // reliable
        view.setUint8(1, 0x32)  // event_code
        console.debug(braking)
        view.setUint8(2, braking ? 0x01 : 0x00)
        this.socket.send(abuf)
    }

}