const http = require('http')
const https = require('https')
const { readableToString, sendRequest } = require('./util')
const url = require('url')

exports.publicCollectionId = 'https://www.w3.org/ns/activitystreams#Public'

// Given an AS2 Object, return whether it appears to be an "subtype of Activity"
// as required for https://w3c.github.io/activitypub/#object-without-create
// #TODO - What if it's an extension activity that describes itself via
//   rdfs as a subtype of Activity?
exports.as2ObjectIsActivity = (obj) => {
  // https://www.w3.org/TR/activitystreams-vocabulary/#activity-types
  const activityTypes = [
    'Accept', 'Add', 'Announce', 'Arrive', 'Block', 'Create', 'Delete',
    'Dislike', 'Flag', 'Follow', 'Ignore', 'Invite', 'Join', 'Leave', 'Like',
    'Listen', 'Move', 'Offer', 'Question', 'Reject', 'Read', 'Remove',
    'TentativeReject', 'TentativeAccept', 'Travel', 'Undo', 'Update', 'View'
  ]
  return activityTypes.includes(obj.type)
}

// given an activity, return a set of targets it should be delivered to
// upon receipt in an outbox
const activityTargets = (activity) => {
  const primary = [].concat(activity.to, activity.cc, activity.bcc).filter(Boolean)
  const notification = [] // #TODO... https://github.com/w3c/activitypub/issues/161
  const targets = Array.from(new Set([].concat(primary, notification)))
  return targets;
}

// Create a headers map for http.request() incl. any specced requirements for ActivityPub Client requests
exports.clientHeaders = (headers = {}) => {
  const requirements = {
    // The client MUST specify an Accept header with the application/ld+json; profile="https://www.w3.org/ns/activitystreams#" media type in order to retrieve the activity.
    //  #critique: This is weird because AS2's official mimetype is application/activity+json, and the ld+json + profile is only a SHOULD, but in ActivityPub this is switched
    accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams#'
  }
  if (Object.keys(headers).map(h => h.toLowerCase()).includes('accept')) {
    throw new Error(`ActivityPub Client requests can't include custom Accept header. Must always be the same value of "${requirements.accept}"`)
  }
  return Object.assign(requirements, headers)
}

const makeErrorClass = (name, setUp) => class extends Error {
  constructor (msg) {
    super(msg)
    this.name = name
    if (typeof setUp === 'function') setUp.apply(this, arguments)
  }
}

const deliveryErrors = exports.deliveryErrors = {
  // Failed to send HTTP request to a target
  TargetRequestFailed: makeErrorClass('TargetRequestFailed'),
  // Failed to parse target HTTP response as JSON
  TargetParseFailed: makeErrorClass('TargetParseFailed'),
  // Target could be fetched, but couldn't determine any .inbox
  InboxDiscoveryFailed: makeErrorClass('InboxDiscoveryFailed'),
  // Found an inbox, but failed to POST delivery to it
  DeliveryRequestFailed: makeErrorClass('DeliveryRequestFailed'),
  // At least one delivery did not succeed. Try again later?
  SomeDeliveriesFailed: makeErrorClass('SomeDeliveriesFailed', function (failures) {
    this.failures = failures
  })
}

const request = (urlOrOptions, ...otherArgs) => {
  const options = typeof urlOrOptions === 'string' ? url.parse(urlOrOptions) : urlOrOptions
  return (options.protocol === 'https:' ? https : http).request(urlOrOptions, ...otherArgs)
}

// deliver an activity to a target
const deliverActivity = async function (activity, target) {
  // discover inbox
  const targetProfileRequest = request(Object.assign(url.parse(target), {
    headers: exports.clientHeaders()
  }))
  try {
    var targetProfileResponse = await sendRequest(targetProfileRequest)
  } catch (e) {
    throw new deliveryErrors.TargetRequestFailed(e.message)
  }
  const targetProfileResponseBody = await readableToString(targetProfileResponse)
  try {
    var targetProfile = JSON.parse(targetProfileResponseBody)
  } catch (e) {
    throw new deliveryErrors.TargetParseFailed(e.message)
  }

  if (!targetProfile.inbox) throw new deliveryErrors.InboxDiscoveryFailed('No .inbox found for target ' + target)

  // #TODO be more JSON-LD aware when looking for inbox
  const inbox = url.resolve(target, targetProfile.inbox)

  // post to inbox
  const deliveryRequest = http.request(Object.assign(url.parse(inbox), {
    headers: {
      'content-type': 'application/ld+json; profile="https://www.w3.org/ns/activitystreams#'
    },
    method: 'post'
  }))
  deliveryRequest.write(JSON.stringify(activity))
  try {
    await sendRequest(deliveryRequest)
  } catch (e) {
    throw new deliveryErrors.DeliveryRequestFailed(e.message)
  }
  // const delivery = await readableToString(deliveryResponse);
  // debugger;
  // #TODO handle retry/timeout?
  return target
}

// Given an activity, determine its targets and deliver to the inbox of each
// target
exports.targetAndDeliver = async function (activity, targets = activityTargets(activity)) {
  let deliveries = []
  let failures = []
  await Promise.all(
    targets
    .map((target) => {
      // Don't actually deliver to publicCollection URI as it is 'special'
      if (target === exports.publicCollectionId) {
        return Promise.resolve(target);
      }
      return deliverActivity(activity, target)
      .then(d => deliveries.push(d))
      .catch(e => failures.push(e))
    })
  )
  if (failures.length) {
    throw new deliveryErrors.SomeDeliveriesFailed(failures)
  }
  return deliveries
}

