import chalk from "chalk"
import { Application } from "express"
import { get, intersection } from "lodash"
import { SinopiaGithubOAuthCliSupport } from "../cli-support"
import { GithubClient } from "../github"
import {
  Auth,
  AuthCallback,
  AuthPlugin,
  MiddlewarePlugin,
  PackageAccess,
  RemoteUser,
  StorageManager,
} from "../verdaccio-types"

import { Authorization } from "./Authorization"
import { Callback } from "./Callback"
import { InjectHtml } from "./InjectHtml"
import { PluginConfig, pluginName } from "./PluginConfig"

interface UserDetails {
  authToken: string
  orgNames: string[]
  expires: number
}

const cacheTTLms = 1000 * 30 // 30s

/**
 * Implements the verdaccio plugin interfaces.
 */
export default class GithubOauthUiPlugin implements MiddlewarePlugin, AuthPlugin {

  private readonly github = new GithubClient(this.config.user_agent)
  private readonly cache: { [username: string]: UserDetails } = {}
  private readonly cliSupport = new SinopiaGithubOAuthCliSupport(this.config, this.stuff)

  constructor(
    private config: PluginConfig,
    private stuff: any,
  ) {
    this.validateConfig(config)
  }

  /**
   * Implements the middleware plugin interface.
   */
  register_middlewares(app: Application, auth: Auth, storage: StorageManager) {
    this.cliSupport.register_middlewares(app, auth, storage)

    if (get(this.config, "web.enable", true)) {
      const injectHtml = new InjectHtml()

      app.use(injectHtml.injectAssetsMiddleware)
      app.use(InjectHtml.path, injectHtml.serveAssetsMiddleware)
    }

    const authorization = new Authorization(this.config)
    const callback = new Callback(this.config, auth)

    app.use(Authorization.path, authorization.middleware)
    app.use(Callback.path, callback.middleware)
  }

  adduser(user: string, password: string, cb: () => void): void {
    // TODO
  }

  changePassword(user: string, password: string, newPassword: string, cb: () => void): void {
    // TODO
  }

  /**
   * Implements the auth plugin interface.
   */
  async authenticate(username: string, authToken: string, cb: AuthCallback) {
    let details = this.cache[username]

    if (!details || details.authToken !== authToken || details.expires > Date.now()) {
      try {
        const orgs = await this.github.requestUserOrgs(authToken)
        const orgNames = orgs.map(org => org.login)

        details = this.cache[username] = {
          authToken,
          expires: Date.now() + cacheTTLms,
          orgNames,
        }
      } catch (error) {
        cb(error, false)
      }
    }

    if (details.orgNames.includes(this.config.org)) {
      cb(null, details.orgNames)
    } else {
      cb(this.denied(username), false)
    }
  }

  allow_access(user: RemoteUser, pkg: PackageAccess, cb: any): void {
    const requiredAccess = [...pkg.access || []]
    if (requiredAccess.includes("$authenticated")) {
      requiredAccess.push(this.config.auth[pluginName].org)
    }

    const grantedAccess = intersection(user.groups, requiredAccess)

    if (grantedAccess.length === requiredAccess.length) {
      cb(null, user.groups)
    } else {
      cb(this.denied(user.name), false)
    }
  }

  // allow_publish(user: RemoteUser, pkg: PackageAccess, cb: any): void {
  //   // TODO
  // }

  private denied(name: RemoteUser["name"]): string {
    return `user "${name}" is not a member of "${this.config.org}"`
  }

  private validateConfig(config: PluginConfig) {
    this.validateConfigProp(config, `auth.${pluginName}.org`)
    this.validateConfigProp(config, `middlewares.${pluginName}.client-id`)
    this.validateConfigProp(config, `middlewares.${pluginName}.client-secret`)
  }

  private validateConfigProp(config: PluginConfig, prop: string) {
    if (!get(config, prop)) {
      console.error(chalk.red(
        `[${pluginName}] ERR: missing configuration "${prop}", please check your verdaccio config`))
      process.exit(1)
    }
  }

}
