import * as $ from 'jquery'
import { ByteArrayInputStream } from "../util";
import { Player, readUpdatePlayerFromStream, readInitialPlayerFromStream } from "./Player";
import { Wall } from "./Wall";
import { GameScene } from "./GameScene";
import { GameObjects, Scene, Input } from "phaser";

export enum ClientState {
    UNINITIALIZED, SPECTATING, REQUESTING_TRANSITION_TO_PLAYING, PLAYING
}

export class Client {
    url: string
    socket: WebSocket
    state: ClientState

    private resolveTransitionRequest: any
    private rejectTransitionRequest: any
    playerId: integer = null
    player: Player = null

    private sendPlayerTask: number = null
    private playerDx: number = 0
    private playerDy: number = 0
    
    constructor(url: string, private scene: GameScene) {
        this.url = url
        this.socket = new WebSocket(url)
        this.socket.onopen = () => {
            console.info("Socket opened at", url)
        }
        this.setUninitialized()
    }

    async requestTransitionToPlaying(request: BecomePlayerRequest): Promise<string> {
        this.state = ClientState.REQUESTING_TRANSITION_TO_PLAYING;
        // Reliable, and transition
        this.socket.send("rt" + JSON.stringify(request));
        return new Promise((resolve, reject) => {
            this.resolveTransitionRequest = resolve;
            this.rejectTransitionRequest = reject;
        })
    }

    private setUninitialized() {
        this.state = ClientState.UNINITIALIZED
        this.socket.onmessage = (data) => {
            console.info('Received init data', data)
            this.readInitializationMessage(data.data)
        }
        this.socket.onclose = (data) => {
            console.info("socket closed")
            if (this.sendPlayerTask != null) {
                clearInterval(this.sendPlayerTask)
            }
        }
    }

    private setSpectating() {
        this.state = ClientState.SPECTATING
        this.socket.onmessage = async (data) => {
            const buf = await new Response(data.data).arrayBuffer()
            const stream = new ByteArrayInputStream(buf)

            const channel_type = stream.readByte()  // temporary measure for the protocol
            if (channel_type == 117) {  // unreliable
                this.readPeriodicGameUpdate(stream)
            } else if (channel_type == 114) {  // reliable
                const event_type = stream.readByte()
                console.debug("received reliable message", data.data)
                switch (event_type) {
                    case 0x01:  // Transition response
                        this.readTransitionResponse(stream)
                        break;
                    case 0x41:  // player join
                        this.readPlayerJoinedEvent(stream)
                        break;
                    case 0x90:  // kills
                        this.readPlayerKilledEvent(stream)
                        break;
                    default:
                        break;
                }
            }
        }
    }

    private readPlayerKilledEvent(stream: ByteArrayInputStream) {
        const count = stream.readShort()
        console.log("Reading", count, "kill events")
        const deadPlayers: Array<integer> = []
        for (var i = 0; i < count; i++) {
            const killerID = stream.readShort()
            const victimID = stream.readShort()
            const killerKills = stream.readShort()
            this.scene.players.get(killerID).kills = killerKills
            console.info(this.scene.players.get(killerID).player_name, "killed", this.scene.players.get(victimID).player_name)
            deadPlayers.push(victimID)
        }

        this.scene.highScores = this.scene.highScores.filter(p => deadPlayers.find(q => q === p.id) == undefined)
        this.scene.highScores.sort((a, b) => a.kills - b.kills)
    }

    private readPeriodicGameUpdate(stream: ByteArrayInputStream) {
        const player_count = stream.readShort()
        const unupdated_players = new Map<integer, boolean>()

        for (var id of this.scene.players.keys()) {
            unupdated_players.set(id, true)
        }
        for (var i = 0; i < player_count; i++) {
            const data = readUpdatePlayerFromStream(stream)         
            const player = this.scene.players.get(data.id)
            if (player != undefined) {
                player.applyServerUpdate(data)
            }
            unupdated_players.delete(data.id)
        }
        for (var id of unupdated_players.keys()) {
            console.debug(id, "was not updated")
            this.scene.players.get(id).destroy()
            this.scene.players.delete(id)
        }
    }

    private readTransitionResponse(stream: ByteArrayInputStream) {
        const code = stream.readByte()
        switch (code) {
            case 0:
                this.state = ClientState.PLAYING
                this.playerId = stream.readShort()
                console.log("Received player id", this.playerId)
                const self = this
                this.sendPlayerTask = <any> setInterval(() => self.sendPlayerInput(), 100)
                this.resolveTransitionRequest(null)
                return;
            case 1:
                this.rejectTransitionRequest('Malformed request')
                break;
            case 2:
                this.rejectTransitionRequest('Username already taken')
                break;
            case 3:
                this.rejectTransitionRequest('Username too long')
                break;
            case 4:
                this.rejectTransitionRequest('Username empty')
                break;
        }
        this.state = ClientState.SPECTATING
    }

    private async readPlayerJoinedEvent(stream: ByteArrayInputStream) {
        const count = stream.readShort();
        console.info("Reading", count, "new players")
        for (var i = 0; i < count; i++) {
            const data = readInitialPlayerFromStream(stream)
            console.log("player with", data, "joined")
            const player = this.scene.addPlayer(data)
            if (this.player == null && player.id == this.playerId) {
                this.player = player
                this.onThisPlayerCreated()
            }
        }
    }

    private async readInitializationMessage(blob: Blob) {
        const data = await new Response(blob).arrayBuffer()
        console.debug("Received potential initialization message", data)

        const stream = new ByteArrayInputStream(data)
        stream.readByte()  // clear u/r
        const event_code = stream.readByte()  // clear event_code

        if (event_code != 0x5) {
            console.warn("Message was NOT an initialization message! Ignoring.")
            return;
        }

        this.setSpectating()

        const version = stream.readStringUntilNull()
        console.info("Server version ", version)

        const wallCount = stream.readShort()
        console.debug("Reading", wallCount, "walls")
        for (var i = 0; i < wallCount; i++) {
            const wall = Wall.readFromStream(this.scene, stream)
            this.scene.addWall(wall)
            this.scene.add.circle(wall.x, wall.y, 0.1, 0x0000ff)
            const cent = wall.getCenter()
            this.scene.add.circle(cent.x, cent.y, 0.1, 0x00ff00)
        }

        const playerCount = stream.readShort()
        console.debug("Reading", playerCount, "players")
        for (var i = 0; i < playerCount; i++) {
            const data = readInitialPlayerFromStream(stream)
            this.scene.addPlayer(data)
        }
        this.socket.send('rk')  // reliable, acknowledge
    }

    private sendPlayerInput() {
        const buf = new ArrayBuffer(10)
        const dv = new DataView(buf)
        dv.setUint8(0, 117)  // unreliable
        dv.setUint8(1, 0x3a)  // set_input command code
        dv.setFloat32(2, this.playerDx / 10, true)
        dv.setFloat32(6, this.playerDy / 10, true)
        // console.debug("sending", this.playerDx, this.playerDy)
        this.socket.send(buf)
    }

    setPlayerInput(dx: number, dy: number) {
        this.playerDx = dx
        this.playerDy = dy
    }

    private onThisPlayerCreated() {
        const cam = this.scene.cameras.main
        cam.startFollow(this.player)
        cam.zoom = 6
        const ih = new PlayerInputHandler(this.scene, this)
        this.scene.add.existing(ih)
    }

    sendBoost() {
        const abuf = new ArrayBuffer(2)
        const view = new DataView(abuf)
        view.setUint8(0, 114)  // reliable
        view.setUint8(1, 0x52)  // event_code
        this.socket.send(abuf)
    }

    sendBrake(braking: boolean) {
        const abuf = new ArrayBuffer(3)
        const view = new DataView(abuf)
        view.setUint8(0, 114)  // reliable
        view.setUint8(1, 0x32)  // event_code
        console.debug(braking)
        view.setUint8(2, braking ? 0x01 : 0x00)
        this.socket.send(abuf)
    }

}

interface BecomePlayerRequest {
    username: string;
    player_class: integer;
}

export class PlayerInputHandler extends GameObjects.GameObject {
    private pointer: Input.Pointer
    private player: Player
    constructor(scene: Scene, private client: Client) {
        super(scene, 'player-input-handler')
        this.pointer = this.scene.game.input.activePointer
        this.player = client.player
        // this.scene.input.setPollAlways()
        // this.scene.input.on('pointermove', () => {
        //     const p = scene.cameras.main.getWorldPoint(this.pointer.x, this.pointer.y)
        //     const dx = p.x - this.player.x
        //     const dy = p.y - this.player.y
        //     console.debug(dx, dy)
        //     client.setPlayerInput(dx, dy)
        // })

        const receiver = $('body')
        receiver.mousemove((event) => {
            const p = scene.cameras.main.getWorldPoint(event.pageX, event.pageY)
            const dx = p.x - this.player.x
            const dy = p.y - this.player.y
            // console.debug(dx, dy)
            client.setPlayerInput(dx, dy)
        })
        receiver.mousedown((event) => {
            console.debug(event)
            switch (event.button) {
                case 0:  // Left
                    client.sendBoost()
                    break;
                case 2:  // Right
                    client.sendBrake(true)
                    break;
            }
        })
        receiver.mouseup((event) => {
            console.debug(event)
            switch (event.button) {
                case 2:  // Right
                    client.sendBrake(false)
                    break;
            }
        })
        receiver.bind('contextmenu', (event) => {
            return false
        })
    }
}