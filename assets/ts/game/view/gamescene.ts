import * as $ from "jquery";
import { Scene } from "phaser";
import { GameState, Wall } from "../gamestate";
import { Client, ClientState } from '../protocol';
import { PlayerRenderer } from "./player";
import { WallRenderer } from "./wall";
import { PlayerInputHandler } from "./input";



interface GameSceneArgs {
    client: Client
}

export class GameScene extends Scene {
    players: Map<integer, PlayerRenderer> = new Map()
    walls: WallRenderer[] = []
    gs: GameState
    client: Client

    highScores: Array<PlayerRenderer> = []
    player_input?: PlayerInputHandler

    constructor() {
        super('game_scene')
        console.log("Constructor of scene")
    }

    init(data: GameSceneArgs) {
        if (data.client.state != ClientState.ACTIVE) {
            throw "Client must be ACTIVE!"
        }
        this.client = data.client
        console.log("Initializing gamescene with is_player=", data.client.is_player)
    }

    preload() {
        console.info("GAME PHASE: Preload")
    }

    create() {
        console.info("GAME PHASE: Create")

        ;(this.client.game_state as GameState).on_player_join = (p) => {
            this.add_player(p.id)
        }
        this.client.on_update_payload = () => {
            this.players.forEach(p => {
                p.destroyed = true
            })
            this.players.forEach(pr => {
                pr.on_update_payload()
                if (pr.player_id == this.client.player_id) {
                    console.info("Player object", pr)
                    //this.cameras.main.startFollow(p)
                    if (this.player_input == undefined) {
                        this.player_input = new PlayerInputHandler(this, this.client)
                    }
                }
            })
            this.players.forEach(p => {
                if (p.destroyed) {
                    p.destroy()
                    this.players.delete(p.player_id)
                }
            })
        }
        this.gs = this.client.game_state as GameState

        this.gs.walls.forEach(w => {
            console.info(w)
            this.add_wall(w)
        })
        this.gs.players.forEach((p, i) => {
            console.info(p)
            this.add_player(i)
        })

        const cam = this.cameras.main
        cam.zoom = 1

        this.scale.addListener(Phaser.Scale.Events.RESIZE, (size: any) => {
            cam.setSize(size.width, size.height)
            cam.centerToSize()
        })

    }

    update() {
        if (!this.client.is_player) {
            this.cameras.main.centerOn(0, 0)
        }
    }

    add_wall(wall: Wall) {
        const obj = new WallRenderer(this, wall)
        this.add.existing(obj)
        this.walls.push(obj)
    }

    add_player(id: integer): PlayerRenderer {
        const player = new PlayerRenderer(this, this.gs, id)
        this.add.existing(player)
        this.players.set(id, player)
        return player
    }

}