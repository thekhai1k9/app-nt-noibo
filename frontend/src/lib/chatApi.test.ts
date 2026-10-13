import { mockFetch } from '../test/mockFetch'
import { chatApi } from './chatApi'

describe('chatApi', () => {
  it('builds the messages URL from the cursor parameters', async () => {
    const { calls } = mockFetch({
      'GET /api/rooms/5/messages': { json: { items: [], has_more_before: false, has_more_after: false } },
    })
    await chatApi.messages(5, {})
    await chatApi.messages(5, { before: 10, limit: 20 })
    await chatApi.messages(5, { after: 7 })
    await chatApi.messages(5, { around: 42, limit: 30 })
    expect(calls.map((c) => c.path)).toEqual([
      '/api/rooms/5/messages',
      '/api/rooms/5/messages?before=10&limit=20',
      '/api/rooms/5/messages?after=7',
      '/api/rooms/5/messages?around=42&limit=30',
    ])
  })

  it('posts the direct room, read marker, edit and delete with the right payloads', async () => {
    const { calls } = mockFetch({
      'POST /api/rooms/direct': { status: 201, json: { id: 3 } },
      'POST /api/rooms/3/read': { status: 204 },
      'PATCH /api/messages/9': { json: { id: 9 } },
      'DELETE /api/messages/9': { status: 204 },
    })
    await chatApi.openDirect(8)
    await chatApi.markRead(3, 12)
    await chatApi.editMessage(9, 'mới')
    await chatApi.deleteMessage(9)
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/api/rooms/direct', { user_id: 8 }],
      ['POST', '/api/rooms/3/read', { message_id: 12 }],
      ['PATCH', '/api/messages/9', { body: 'mới' }],
      ['DELETE', '/api/messages/9', undefined],
    ])
  })

  it('calls the members and presence endpoints', async () => {
    const { calls } = mockFetch({
      'GET /api/rooms/4/members': { json: [{ user_id: 1, full_name: 'A', last_read_message_id: null }] },
      'GET /api/presence': { json: { online_user_ids: [1, 2] } },
    })
    expect(await chatApi.members(4)).toEqual([{ user_id: 1, full_name: 'A', last_read_message_id: null }])
    expect(await chatApi.presence()).toEqual({ online_user_ids: [1, 2] })
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/api/rooms/4/members'],
      ['GET', '/api/presence'],
    ])
  })

  it('encodes the directory search term', async () => {
    const { calls } = mockFetch({ 'GET /api/users/directory': { json: [] } })
    await chatApi.directory('ha le & co')
    await chatApi.directory('')
    expect(calls.map((c) => c.path)).toEqual(['/api/users/directory?q=ha%20le%20%26%20co', '/api/users/directory'])
  })
})

describe('chatApi: groups', () => {
  it('uses the exact paths, methods and bodies for the six group calls', async () => {
    const { calls } = mockFetch({
      'POST /api/rooms/group': { status: 201, json: { id: 7 } },
      'PATCH /api/rooms/7': { json: { id: 7 } },
      'POST /api/rooms/7/members': { json: [] },
      'DELETE /api/rooms/7/members/9': { json: [] },
      'POST /api/rooms/7/leave': { status: 204 },
      'DELETE /api/rooms/7': { status: 204 },
    })
    await chatApi.createGroup('Kho', [2, 3])
    await chatApi.renameGroup(7, 'Kho mới')
    await chatApi.addMember(7, 9)
    await chatApi.removeMember(7, 9)
    await chatApi.leaveGroup(7)
    await chatApi.dissolveGroup(7)
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/api/rooms/group', { name: 'Kho', member_ids: [2, 3] }],
      ['PATCH', '/api/rooms/7', { name: 'Kho mới' }],
      ['POST', '/api/rooms/7/members', { user_id: 9 }],
      ['DELETE', '/api/rooms/7/members/9', undefined],
      ['POST', '/api/rooms/7/leave', undefined],
      ['DELETE', '/api/rooms/7', undefined],
    ])
  })
})
