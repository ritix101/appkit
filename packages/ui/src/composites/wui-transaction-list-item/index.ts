import { html, LitElement } from 'lit'
import { property } from 'lit/decorators.js'
import '../../components/wui-text/index.js'
import type { TransactionDirection, TransactionStatus } from '@web3modal/core'
import { elementStyles, resetStyles } from '../../utils/ThemeUtil.js'
import { customElement } from '../../utils/WebComponentsUtil.js'
import '../wui-transaction-visual/index.js'
import styles from './styles.js'
import { TransactionTypePastTense, type TransactionType } from '../../utils/TypeUtil.js'

@customElement('wui-transaction-list-item')
export class WuiTransactionListItem extends LitElement {
  public static override styles = [resetStyles, elementStyles, styles]

  // -- State & Properties -------------------------------- //
  @property() public type: TransactionType = 'approve'

  @property() public description?: string[]

  @property() public date?: string

  @property() public status?: TransactionStatus

  @property() public direction?: TransactionDirection

  @property() public imageURL?: string

  @property() public secondImageURL?: string

  @property({ type: Boolean }) public isNFT?: boolean

  // -- Render -------------------------------------------- //
  public override render() {
    const firstDesc = this.description?.[0]
    const secondDesc = this.description?.[1]

    return html`
      <wui-flex>
        <wui-transaction-visual
          status=${this.status}
          direction=${this.direction}
          type=${this.type}
          isNFT=${this.isNFT}
          imageURL=${this.imageURL}
          secondImageURL=${this.secondImageURL}
        ></wui-transaction-visual>
        <wui-flex flexDirection="column" gap="3xs">
          <wui-text variant="paragraph-600" color="fg-100"
            >${TransactionTypePastTense[this.type]}</wui-text
          >
          <wui-flex class="description-container">
            ${firstDesc
              ? html`<wui-text variant="small-500" color="fg-200">
                  <span>${firstDesc}</span>
                </wui-text>`
              : null}
            ${secondDesc
              ? html`
                  <wui-icon
                    class="description-separator-icon"
                    size="xxs"
                    name="arrowRight"
                  ></wui-icon>
                  <wui-text variant="small-500" color="fg-200">
                    <span>${secondDesc}</span>
                  </wui-text>
                `
              : null}
          </wui-flex>
        </wui-flex>
        <wui-text variant="micro-700" color="fg-300"><span>${this.date}</span></wui-text>
      </wui-flex>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'wui-transaction-list-item': WuiTransactionListItem
  }
}
