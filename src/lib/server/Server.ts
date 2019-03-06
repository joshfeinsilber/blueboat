import bodyParser from 'body-parser'
import Express from 'express'
import basicAuth from 'express-basic-auth'
import { Server as HTTPServer } from 'http'
import nrp from 'node-redis-pubsub'
import socket from 'socket.io'
import MessagePackParser from 'socket.io-msgpack-parser'
import redisAdapter from 'socket.io-redis'
import sticky from 'sticky-cluster'
import AvaiableRoomType from '../../types/AvailableRoomType'
import SimpleClient from '../../types/SimpleClient'
import GetGameValues from '../api/GetGameValues'
import GetRoom from '../api/GetRoom'
import GetRooms from '../api/GetRooms'
import SetGameValues from '../api/SetGameValues'
import InternalActions from '../constants/InternalActions'
import { PLAYER_LEFT } from '../constants/PubSubListeners'
import BUNDLED_PANEL_JS from '../panel/bundle'
import Room from '../room/Room'
import ConnectionHandler from './Connection/ConnectionHandler'
import CustomGameValues from './CustomGameValues'
import Emitter from './Emitter'
import RedisClient from './RedisClient'
import RoomFetcher from './RoomFetcher'

const WORKERS = Number(process.env.WEB_CONCURRENCY) || 1

const PANEL_PREFIX = '/blueboat-panel'
const PANEL_HTML = `
<html>
<head>
<title>Blueboat Panel</title>
</head>
<div id='root'></div>
<script>
${BUNDLED_PANEL_JS.js}
</script>
</html>
`

interface RedisOptions {
  host: string
  port: number
  auth_pass?: string
  requestsTimeout?: number
}

interface ServerArguments {
  app: Express.Application
  redisOptions: RedisOptions
  admins: any
}

interface ServerState {
  availableRoomTypes: AvaiableRoomType[]
  managingRooms: Room[]
  managingRoomIds: string[]
}

const signals = ['SIGINT', 'SIGTERM', 'SIGUSR2', 'uncaughtException']

class Server {
  public server: HTTPServer = null
  public redis: RedisClient = null
  public gameValues: CustomGameValues

  public state: ServerState = {
    availableRoomTypes: [],
    managingRooms: [],
    managingRoomIds: []
  }
  public listen: (port: number, callback?: () => void) => void = null
  private app: Express.Application = null
  private io: SocketIO.Server = null
  private pubsub: nrp.NodeRedisPubSub
  private roomFetcher: RoomFetcher = null

  constructor(options: ServerArguments) {
    this.app = options.app
    this.redis = new RedisClient({
      clientOptions: options.redisOptions as any
    })
    // @ts-ignore
    this.pubsub = new nrp(options.redisOptions)
    this.roomFetcher = new RoomFetcher({ redis: this.redis })
    this.gameValues = new CustomGameValues({ redis: this.redis })
    this.spawnServer(options.redisOptions, options.admins || {})
  }

  public registerRoom = (roomName: string, handler: any, options?: any) => {
    const { availableRoomTypes } = this.state
    if (availableRoomTypes.map(room => room.name).includes(roomName)) {
      // Can't have two handlers for the same room
      return
    }
    this.state.availableRoomTypes.push({ name: roomName, handler, options })
    return
  }

  public gracefullyShutdown = () =>
    this.shutdown()
      .then()
      .catch()

  private onRoomMade = (room: Room) => {
    this.state.managingRooms.push(room)
    this.state.managingRoomIds.push(room.roomId)
  }
  private onRoomDisposed = (roomId: string) => {
    this.state.managingRooms = this.state.managingRooms.filter(
      room => room.roomId !== roomId
    )
    this.state.managingRoomIds = this.state.managingRoomIds.filter(
      r => r !== roomId
    )
  }

  private spawnServer = (redisOptions: RedisOptions, adminUsers: any) => {
    this.server = new HTTPServer(this.app)
    this.makeRoutes(adminUsers)
    this.listen = (port: number, callback?: () => void) => {
      sticky(
        stickyListen => {
          stickyListen(this.server)
          callback()
        },
        {
          concurrency: WORKERS,
          port
        }
      )
    }
    this.io = socket({
      parser: MessagePackParser,
      path: '/blueboat',
      transports: ['websocket']
    })
    this.io.adapter(redisAdapter(redisOptions))
    this.io.attach(this.server)
    this.io.on('connection', s =>
      ConnectionHandler({
        availableRoomTypes: this.state.availableRoomTypes,
        io: this.io,
        pubsub: this.pubsub,
        redis: this.redis,
        roomFetcher: this.roomFetcher,
        gameValues: this.gameValues,
        socket: s,
        onRoomMade: this.onRoomMade,
        onRoomDisposed: this.onRoomDisposed
      })
    )

    this.spawnPubSub()

    signals.forEach(signal =>
      process.once(signal as any, (reason?: any) =>
        this.shutdown(signal, reason)
      )
    )
  }

  private spawnPubSub = () => {
    this.pubsub.on(PLAYER_LEFT, (playerId: string) => {
      Emitter.emit(PLAYER_LEFT, playerId)
    })
    this.pubsub.on(InternalActions.newRoomMessage, (dataAsString: string) => {
      const data = JSON.parse(dataAsString) as {
        client: SimpleClient
        room: string
        action: string
        data?: any
      }
      if (data.room && this.state.managingRoomIds.includes(data.room)) {
        Emitter.emit(
          data.room,
          JSON.stringify({
            client: data.client,
            action: data.action,
            data: data.data
          })
        )
      }
    })
  }

  private makeRoutes = (adminUsers: any) => {
    const router = Express.Router()
    router.use(bodyParser.json())
    // @ts-ignore
    router.use((req, res, next) => {
      // @ts-ignore
      req.gameServer = this
      next()
    })
    router.use(basicAuth({ users: adminUsers, challenge: true }))
    // @ts-ignore
    router.get('/', (req, res) => {
      res.send(PANEL_HTML)
    })
    router.get('/rooms', GetRooms)
    router.get('/rooms/:room', GetRoom)
    router.get('/gameValues', GetGameValues)
    router.post('/gameValues', SetGameValues)
    this.app.use(PANEL_PREFIX, router)
  }

  private shutdown = async (signal?: string, reason?: any) => {
    if (signal === 'uncaughtException' && reason) {
      console.log(reason)
    }
    try {
      if (!this.state.managingRooms.length) {
        return
      }
      await Promise.all(this.state.managingRooms.map(room => room.dispose()))
    } catch (e) {
      return
    } finally {
      this.server.close()
      process.exit(0)
    }
  }
}

export default Server
