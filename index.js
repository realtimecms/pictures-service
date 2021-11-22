const app = require("@live-change/framework").app()
const validators = require("../validation")
const fs = require("fs")
const rimraf = require("rimraf")
const sharp = require('sharp')
const download = require('download')

const definition = app.createServiceDefinition({
  name: "pictures",
  validators
})

const User = definition.foreignModel('users', 'User')

const Picture = definition.model({
  name: "Picture",
  properties: {
    name: {
      type: String
    },
    fileName: {
      type: String
    },
    original: {
      type: Object,
      properties: {
        width: { type: Number },
        height: { type: Number },
        extension: { type: String }
      }
    },
    crop: {
      type: Object,
      properties: {
        x: { type: Number },
        y: { type: Number },
        width: { type: Number },
        height: { type: Number },
        zoom: { type: Number, defaultValue: 1 },
        orientation: {type: Number}
      }
    },
    owner: {
      type: User,
      validation: ['nonEmpty']
    },
    purpose: {
      type: String,
      validation: ['nonEmpty']
    }
  },
  crud: {
    deleteTrigger: true,
    writeOptions: {
      access: (params, { client, service }) => {
        return client.roles.includes('admin')
      }
    }
  }
})

function move(from, to) {
  return new Promise((resolve,reject) => {
    fs.rename(from, to, (err) => {
      if(err) return reject(err)
      resolve(to)
    })
  })
}

function copy(from, to) {
  return new Promise((resolve,reject) => {
    fs.copyFile(from, to, (err) => {
      if(err) return reject(err)
      resolve(to)
    })
  })
}

function mkdir(name) {
  return new Promise( (resolve, reject) => {
    fs.mkdir(name, { recursive: true }, (err) => {
      if(err) return reject(err)
      resolve(name)
    })
  })
}

function rmdir(path) {
  return new Promise( (resolve, reject) => {
    rimraf("/some/directory", (err) => {
      if(err) return reject(err)
      resolve(path)
    })
  })
}

definition.action({
  name: "createEmptyPicture",
  properties: {
    name: {
      type: String,
      validation: ['nonEmpty']
    },
    purpose: {
      type: String,
      validation: ['nonEmpty']
    }
  },
  async execute({ name, purpose }, { client, service }, emit) {
    const picture = app.generateUid()

    const dir = `../../storage/pictures/${picture}`

    emit({
      type: "PictureCreated",
      picture,
      data: {
        name,
        purpose,
        fileName: null,
        original: null,
        crop: null,
        owner: client.user
      }
    })

    await mkdir(dir)
    await mkdir(`${dir}/originalCache`)
    await mkdir(`${dir}/cropCache`)

    return picture
  }
})

definition.action({
  name: "uploadPicture",
  properties: {
    picture: {
      type: Picture
    },
    original: {
      type: Object,
      properties: {
        width: { type: Number },
        height: { type: Number },
        uploadId: { type: String }
      }
    }
  },
  waitForEvents: true,
  async execute({ picture, original }, { client, service }, emit) {
    const upload = await app.dao.get(['database', 'tableObject', app.databaseName, 'uploads', original.uploadId])
    if(!upload) throw new Error("upload_not_found")
    if(upload.state!='done') throw new Error("upload_not_done")

    let extension = upload.fileName.match(/\.([A-Z0-9]+)$/i)[1].toLowerCase()
    if(extension == 'jpg') extension = "jpeg"
    const dir = `../../storage/pictures/${picture}`

    emit({
      type: "PictureUpdated",
      picture,
      data: {
        fileName: upload.fileName,
        original: {
          width: original.width,
          height: original.height,
          extension
        },
        crop: null
      }
    })

    await move(`../../storage/uploads/${upload.id}`, `${dir}/original.${extension}`)
    await app.dao.request(['database', 'delete'], app.databaseName, 'uploads', upload.id)

    return picture
  }
})

definition.action({
  name: "createPicture",
  properties: {
    name: {
      type: String,
      validation: ['nonEmpty']
    },
    original: {
      type: Object,
      properties: {
        width: { type: Number },
        height: { type: Number },
        uploadId: { type: String }
      }
    },
    purpose: {
      type: String,
      validation: ['nonEmpty']
    }
  },
  waitForEvents: true,
  async execute({ name, original, purpose }, { client, service }, emit) {
    const picture = app.generateUid()
    const upload = await app.dao.get(['database', 'tableObject', app.databaseName, 'uploads', original.uploadId])

    if(!upload) throw new Error("upload_not_found")
    if(upload.state!='done') throw new Error("upload_not_done")

    let extension = upload.fileName.match(/\.([A-Z0-9]+)$/i)[1].toLowerCase()
    if(extension == 'jpg') extension = "jpeg"
    const dir = `../../storage/pictures/${picture}`

    emit({
      type: "PictureCreated",
      picture,
      data: {
        name,
        purpose,
        fileName: upload.fileName,
        original: {
          width: original.width,
          height: original.height,
          extension
        },
        crop: null,
        owner: client.user
      }
    })

    await mkdir(dir)
    await mkdir(`${dir}/originalCache`)
    await mkdir(`${dir}/cropCache`)
    await move(`../../storage/uploads/${upload.id}`, `${dir}/original.${extension}`)
    await app.dao.request(['database', 'delete'], app.databaseName, 'uploads', upload.id)

    return picture
  }
})


definition.action({
  name: "cropPicture",
  properties: {
    picture: {
      type: Picture
    },
    crop: {
      type: Object,
      properties: {
        x: {type: Number},
        y: {type: Number},
        width: {type: Number},
        height: {type: Number},
        zoom: {type: Number, defaultValue: 1},
        orientation: {type: Number}
      }
    },
    uploadId: {type: String}
  },
  waitForEvents: true,
  async execute({ picture, crop, uploadId }, {client, service}, emit) {
    const pictureRow = await Picture.get(picture)
    if(!pictureRow) throw new Error("not_found")

    const upload = await app.dao.get(['database', 'tableObject', app.databaseName, 'uploads', uploadId])

    console.log("UPLOAD CROP", upload)

    if(!upload) throw new Error("upload_not_found")
    if(upload.state != 'done') throw new Error("upload_not_done")

    console.log("CURRENT PICTURE ROW", picture, pictureRow)
    if(!pictureRow.crop) { // first crop
      const dir = `../../storage/pictures/${picture}`
      let extension = upload.fileName.match(/\.([A-Z0-9]+)$/i)[1].toLowerCase()
      if(extension == 'jpg') extension = "jpeg"

      await move(`../../storage/uploads/${upload.id}`, `${dir}/crop.${extension}`)
      await app.dao.request(['database', 'delete'], app.databaseName, 'uploads', upload.id)

      emit([{
        type: "PictureUpdated",
        picture,
        data: {
          crop,
          owner: client.user
        }
      }])

      return picture
    } else { // next crop - need to copy picture
      const newPicture = app.generateUid()

      const dir = `../../storage/pictures/${picture}`
      const newDir = `../../storage/pictures/${newPicture}`

      await mkdir(newDir)
      await mkdir(`${newDir}/originalCache`)
      await mkdir(`${newDir}/cropCache`)
      await move(`${dir}/original.${pictureRow.original.extension}`,
          `${newDir}/original.${pictureRow.original.extension}`)

      let extension = upload.fileName.match(/\.([A-Z0-9]+)$/i)[1].toLowerCase()
      if(extension == 'jpg') extension = "jpeg"

      await move(`../../storage/uploads/${upload.id}`, `${newDir}/crop.${extension}`)
      await app.dao.request(['database', 'delete'], app.databaseName, 'uploads', upload.id)

      emit({
        type: "PictureCreated",
        picture: newPicture,
        data: {
          name: pictureRow.name,
          purpose: pictureRow.purpose,
          fileName: upload.fileName,
          original: pictureRow.original,
          crop,
          owner: client.user
        }
      })

      return newPicture
    }


  }
})

definition.trigger({
  name: "createPictureFromUrl",
  properties: {
    name: {
      type: String,
      validation: ['nonEmpty']
    },
    purpose: {
      type: String,
      validation: ['nonEmpty']
    },
    url: {
      type: String,
      validation: ['nonEmpty']
    },
    owner: {
      type: User,
      validation: ['nonEmpty']
    },
    cropped: {
      type: Boolean,
      defaultValue: true
    }
  },
  waitForEvents: true,
  async execute({ name, purpose, url, owner, cropped }, { service, client }, emit) {
    const picture = app.generateUid()

    const downloadPath = `../../storage/uploads/download_${picture}`
    await download(url, '../../storage/uploads/', { filename: `download_${picture}` })

    const metadata = await sharp(downloadPath).metadata()

    let data = {
      name,
      purpose,
      fileName: url.split('/').pop(),
      original: {
        width: metadata.width,
        height: metadata.height,
        extension: metadata.format
      },
      crop: null,
      owner
    }

    if(cropped) {
      data.crop = {
        x: 0,
        y: 0,
        width: metadata.width,
        height: metadata.height,
        zoom: 1,
        orientation: 0
      }
    }

    emit({
      type: "PictureCreated",
      picture,
      data
    })

    const dir = `../../storage/pictures/${picture}`

    await mkdir(dir)
    await mkdir(`${dir}/originalCache`)
    await mkdir(`${dir}/cropCache`)
    await move(downloadPath, `${dir}/original.${metadata.format}`)
    if(cropped) await copy(`${dir}/original.${metadata.format}`, `${dir}/crop.${metadata.format}`)

    return picture
  }
})

module.exports = definition

async function start() {
  if(!app.dao) {
    await require('@live-change/server').setupApp({})
    await require('@live-change/elasticsearch-plugin')(app)
  }

  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason)
  })

  app.processServiceDefinition(definition, [ ...app.defaultProcessors ])
  await app.updateService(definition)//, { force: true })
  const service = await app.startService(definition, { runCommands: true, handleEvents: true })

}

if (require.main === module) start().catch( error => { console.error(error); process.exit(1) })
