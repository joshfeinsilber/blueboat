import cors from 'cors'
import Express from 'express'
import { Server } from '../index'
import EventEmitter from '../lib/pubsub/EventEmitter'
import ChatRoom from './ChatRoom'

const redisOptions = {
  host: 'localhost',
  port: 6379
}

const app = Express()
app.use(cors())
app.options('*', cors())
const server = new Server({
  app,
  redisOptions,
  pubsub: EventEmitter(),
  admins: { blueboat: 'pass' }
})

server.registerRoom('Chat', ChatRoom, { come: 'on' })
server.listen(4000, () => console.log('Server listening on port 4000'))
